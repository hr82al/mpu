/**
 * Правила подтверждения для тестов строки: файл во временном
 * каталоге, настоящий `~/.config/mpu/policy.db` не трогается.
 */

import { ALLOW, RuleBook, RulePath } from "../policy/mod.ts";
import {
  immediately,
  type LinePorts,
  type Memory,
  NO_CALLER,
  terminalChannel,
} from "./mod.ts";
import { registrySeeds } from "./seeds.ts";

/** Файл правил во временном каталоге на время `body`. */
export async function withPolicyFile(
  body: (file: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(`${dir}/policy.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
    rootMethods: [],
    memory,
  };
}

/**
 * Правила, дающие `allow` любой строке: посев снят, на корне `allow`.
 * Посев виден, поэтому следующие старты его не вернут.
 */
export function allowEverything(file: string) {
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
}
