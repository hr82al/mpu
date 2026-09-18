/**
 * Правила подтверждения для тестов `mpu-next`: файл во временном
 * каталоге, настоящий `~/.config/mpu/policy.db` не трогается.
 */

import { ALLOW, RuleBook, RulePath } from "../policy/mod.ts";
import type { Consent } from "./mod.ts";
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

/** Окружение правил с файлом `file`; ответы человека — по очереди. */
export function consentOf(
  file: string,
  answers: readonly string[] = [],
): Consent {
  const queue = [...answers];
  return { file, readLine: () => Promise.resolve(queue.shift()) };
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
