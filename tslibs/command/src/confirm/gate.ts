/**
 * Ворота пайпа (`docs/specs/confirm.md`): вопрос человеку между двумя
 * командами конвейера.
 *
 * Разбор ответа и текст диагностики вынесены из команды: и то и другое
 * проверяется без терминала, а вопрос без терминала не задать.
 */

import type { CommandIo } from "../command/mod.ts";

/** Ответы, означающие «да»; всё прочее — отказ. */
const YES = ["y", "yes"];

/**
 * «Да» ли это. Регистр не важен, обрамляющие пробелы снимаются; конец
 * ввода (`undefined`) и пустая строка — «нет»: умолчание у ворот
 * отрицательное, оттого и `[y/N]` в приглашении.
 */
export function isYes(answer: string | undefined): boolean {
  return YES.includes((answer ?? "").trim().toLowerCase());
}

/** Порт диагностики: три std-fd процесса. */
type TerminalFacts = Pick<
  CommandIo,
  "stdinIsTerminal" | "stdoutIsTerminal" | "stderrIsTerminal"
>;

/**
 * Диагностика «как запущен mpu»: почему терминала не нашлось. Печатается
 * подробностями отказа — человек по ней видит, какой из потоков увели в
 * пайп.
 *
 * Имя устройства не называется ни у одного fd: `ttyname` в Deno нет.
 * Сказано это отдельной строкой, а не молчанием — иначе читатель решит,
 * что имя не напечатано, потому что его не искали (отклонение спеки,
 * `preserve частично`).
 */
export function ttyDiagnostics(io: TerminalFacts): string {
  return [
    "--- tty диагностика (как запущен mpu) ---",
    "/dev/tty: открыть не удалось",
    `fd 0 (stdin): isatty=${io.stdinIsTerminal()}`,
    `fd 1 (stdout): isatty=${io.stdoutIsTerminal()}`,
    `fd 2 (stderr): isatty=${io.stderrIsTerminal()}`,
    "имя устройства: недоступно — ttyname в Deno нет",
  ].join("\n");
}

/**
 * Эхо буфера в служебный поток. Перевод строки добавляется, только
 * если его нет: печатает строку точка входа, и свой перевод она ставит
 * сама — поэтому здесь он, наоборот, снимается.
 *
 * В stdout при этом уходит исходный буфер, без добавленного перевода
 * (спека): ворота меняют судьбу данных, а не сами данные.
 */
export function echoLine(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
