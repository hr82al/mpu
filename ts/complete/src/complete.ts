/**
 * Дополнение строки (`specs/complete.md`, «Дополнение»): дойти по
 * снимку до узла и выдать его варианты для дописываемого слова.
 */

import { treeOf } from "./tree.ts";

/** Слова, которые обход пропускает: режим справки ничего не меняет в пути. */
const SKIPPED: ReadonlySet<string> = new Set(["help", "--help"]);

/** Описание в одну строку: табуляция и перевод строки — пробел. */
function oneLine(text: string): string {
  return text.replace(/[\t\n\r]/g, " ");
}

/**
 * Варианты для строки: по одному `вариант\tописание` на строку, по
 * алфавиту варианта, с переводом строки после каждого.
 *
 * @param words слова строки без имени команды; последнее — дописываемое
 * @param snapshot текст снимка; нет снимка — пустая строка
 */
export function complete(words: readonly string[], snapshot: string): string {
  const typed = words.slice(0, -1);
  const word = words.at(-1) ?? "";
  let place = treeOf(snapshot);
  for (const done of typed) {
    if (!SKIPPED.has(done)) place = place.step(done);
  }
  return place.choices(word)
    .filter((choice) => choice.value.startsWith(word))
    .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    .map((choice) => `${choice.value}\t${oneLine(choice.summary)}\n`)
    .join("");
}
