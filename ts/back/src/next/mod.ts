/**
 * Точка входа `mpu-next` (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком.
 */

import type { CommandIo } from "../command/mod.ts";
import {
  type InvokeJournal,
  JSON_FLAG,
  type Output,
  runLine,
} from "../entrypoint/mod.ts";
import { ESCAPE_WORD } from "../messages/mod.ts";
import { type Outcome, runChain } from "../objects/mod.ts";
import { registryRoot } from "./tree.ts";

/**
 * Слова для обхода цепочки: без `--json` до первого `--` — иначе корень
 * получил бы непонятое сообщение. Исполнение получает исходный argv.
 */
function walkedWords(argv: readonly string[]): string[] {
  const cut = argv.indexOf(ESCAPE_WORD);
  const end = cut < 0 ? argv.length : cut;
  return [
    ...argv.slice(0, end).filter((word) => word !== JSON_FLAG),
    ...argv.slice(end),
  ];
}

/** Итог цепочки в поток и код (данные границы). */
function printed(outcome: Outcome, output: Output): number {
  if ("error" in outcome) {
    output.stderr(`${outcome.error}\n`);
    return 2;
  }
  if ("exit" in outcome) return outcome.exit;
  if ("object" in outcome) {
    output.stdout(outcome.object);
    return 2;
  }
  output.stdout(textOf(outcome.value));
  return 0;
}

/**
 * Данные итога текстом: справка — строка как есть; ответы `selectors` и
 * `respondsTo:` — JSON (формы их печати спека не задаёт).
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return `${JSON.stringify(value)}\n`;
}

/**
 * Исполняет строку вызова `mpu-next` и возвращает код завершения.
 *
 * @param argv argv процесса без имени программы
 * @param io окружение команды
 * @param output потоки процесса
 * @param journal журнал вызовов
 */
export async function runNext(
  argv: readonly string[],
  io: CommandIo,
  output: Output,
  journal?: InvokeJournal,
): Promise<number> {
  const line = { dispatch: () => runLine(argv, io, output, journal) };
  const outcome = await runChain(walkedWords(argv), registryRoot(line));
  return printed(outcome, output);
}
