/**
 * Вычислитель строки (`docs/specs/platform/evaluator.md`): строка
 * `mpu` — программа на маленьком Smalltalk. Выражения, переменные,
 * блоки, условия и циклы — сообщения объектам; команды реестра программа
 * отдаёт ядру отдельными строками.
 */

import { GRAMMAR } from "../messages/mod.ts";

export type { CommandView } from "./data.ts";
export { isProgram } from "./lexis.ts";
export { DEFAULT_PACE_MS, Every, type Pace, Placed } from "./machine.ts";
export {
  type CommandNode,
  type Commands,
  LENIENT_ROOT,
  parseProgram,
  type Root,
} from "./parse.ts";
export {
  type LineReply,
  type ProgramEnd,
  type ProgramPorts,
  refusalOf,
  runProgram,
} from "./run.ts";

/**
 * Абзац справки корня о программе: слова — из константы грамматики, и
 * замена слова в ней меняет справку вместе с разбором.
 */
export function programHelp(): string {
  const g = GRAMMAR;
  return [
    "Программа — несколько выражений в одной строке:",
    `  ${g.separator}  разделяет выражения (отдельным словом)`,
    `  x ${g.assign} <выражение>  переменная; в начале выражения — x или ${g.variable}x,`,
    `    в значении ключа — ${g.variable}x`,
    `  ${g.quote}текст из слов${g.quote}  текст`,
    `  ${g.open} ${g.parameter}a ${g.parameter}b … ${g.blockEnd}  блок с параметрами`,
    `  ${g.comment} … ${g.close}  комментарий`,
    `Условия и циклы — сообщения: 3 greater: 2 ifTrue: ${g.open} ${g.quote}да${g.quote} print ${g.blockEnd};`,
    `  1 to: 3 do: ${g.open} ${g.parameter}i i print ${g.blockEnd}`,
  ].join("\n");
}
