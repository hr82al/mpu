/**
 * Общий `--json` строки: обход цепочки идёт без него, а хвостовой
 * команде он достаётся в исходной строке. Одно правило у строки ядра и
 * у пробы хука.
 */

import { JSON_FLAG } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { JSON_STRIPPED, NOTHING_STRIPPED, type Stripped } from "./keyed.ts";

/** Граница, до которой ищется общий `--json`: первый `--`. */
function jsonEnd(argv: readonly string[]): number {
  const cut = argv.indexOf(GRAMMAR.literal);
  return cut < 0 ? argv.length : cut;
}

/**
 * Слова для обхода цепочки: без `--json` до первого `--` — иначе корень
 * получил бы непонятое сообщение. Исполнение получает исходный argv.
 */
export function walkedWords(argv: readonly string[]): string[] {
  const end = jsonEnd(argv);
  return [
    ...argv.slice(0, end).filter((word) => word !== JSON_FLAG),
    ...argv.slice(end),
  ];
}

/**
 * Снятый `--json`: хвостовой команде он достаётся в исходной строке,
 * ключевой — отказ «формат — сообщение результату».
 */
export function strippedOf(argv: readonly string[]): Stripped {
  const asked = argv.slice(0, jsonEnd(argv)).includes(JSON_FLAG);
  return asked ? JSON_STRIPPED : NOTHING_STRIPPED;
}
