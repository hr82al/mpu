/**
 * Дополнение строки (`platform/reflection.md`, «mpu-complete»): варианты
 * от `mpu-back`, а не ответил он — из снимка дерева.
 */

import { type Choice, treeOf } from "./tree.ts";

/** Описание в одну строку: табуляция и перевод строки — пробел. */
function oneLine(text: string): string {
  return text.replace(/[\t\n\r]/g, " ");
}

/**
 * Варианты текстом: по одному `вариант\tописание` на строку, по алфавиту
 * варианта, с переводом строки после каждого.
 */
export function printed(choices: readonly Choice[]): string {
  return [...choices]
    .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    .map((choice) => `${choice.value}\t${oneLine(choice.summary)}\n`)
    .join("");
}

/**
 * Варианты для строки из снимка: пройти набранные слова и отобрать
 * варианты места по началу дописываемого.
 *
 * @param words слова строки без имени команды; последнее — дописываемое
 * @param snapshot текст снимка; нет снимка — пустая строка
 */
export function fromSnapshot(
  words: readonly string[],
  snapshot: string,
): readonly Choice[] {
  const word = words.at(-1) ?? "";
  let place = treeOf(snapshot);
  for (const done of words.slice(0, -1)) place = place.step(done);
  return place.choices().filter((choice) => choice.value.startsWith(word));
}

/**
 * Варианты текстом по снимку — прежняя поверхность для тестов таблицы.
 *
 * @param words слова строки без имени команды; последнее — дописываемое
 * @param snapshot текст снимка
 */
export function complete(words: readonly string[], snapshot: string): string {
  return printed(fromSnapshot(words, snapshot));
}
