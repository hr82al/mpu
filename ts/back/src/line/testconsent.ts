/**
 * Правила подтверждения для тестов строки: файл во временном
 * каталоге, настоящий `~/.config/mpu/policy.db` не трогается.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IN_PLACE } from "../entrypoint/mod.ts";
import { ALLOW, RulePath } from "@mpu/command/policy";
import {
  immediately,
  IN_PLACE_PROGRAMS,
  type LinePorts,
  type Memory,
  NO_CALLER,
  NO_REFUSAL,
  programFiles,
  terminalChannel,
} from "./mod.ts";
import { openRegistryBook } from "./seeds.ts";

/** Файл правил во временном каталоге; `close` убирает каталог. */
export interface PolicyFile {
  /** Путь файла правил; самого файла до первой записи нет. */
  readonly path: string;
  /** Убирает временный каталог вместе с файлом. */
  close(): Promise<void>;
}

/**
 * Файл правил, живущий дольше одного вызова: набор шагов на одном файле
 * (`beforeAll` открывает, `afterAll` закрывает).
 */
export async function openPolicyFile(): Promise<PolicyFile> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  return {
    path: `${dir}/policy.db`,
    close: () => rm(dir, { recursive: true }),
  };
}

/** Файл правил во временном каталоге на время `body`. */
export async function withPolicyFile(
  body: (file: string) => Promise<void>,
): Promise<void> {
  const file = await openPolicyFile();
  try {
    await body(file.path);
  } finally {
    await file.close();
  }
}

/**
 * Порты строки с файлом `file`: канал терминала (человек — если в
 * подменах окружения stdin и stderr терминалы), ответы — по очереди;
 * память вызывающего — `memory` (по умолчанию вызывающего нет).
 */
export function consentOf(
  file: string,
  answers: readonly string[] = [],
  memory: Memory = NO_CALLER,
): LinePorts {
  const queue = [...answers];
  return {
    file,
    channel: terminalChannel(() => Promise.resolve(queue.shift())),
    execute: immediately,
    invoker: IN_PLACE,
    evaluator: IN_PLACE_PROGRAMS,
    rootMethods: [],
    memory,
    refusal: NO_REFUSAL,
    files: programFiles(() => undefined),
  };
}

/**
 * Правила, дающие `allow` любой строке: посев снят, на корне `allow`.
 * Посев виден, поэтому следующие старты его не вернут.
 */
export function allowEverything(file: string) {
  using book = openRegistryBook(file);
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
}
