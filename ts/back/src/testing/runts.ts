/**
 * Запуск модуля `.ts` текущим рантаймом — для тестов, которым нужен
 * настоящий второй процесс (`platform/node-runtime.md`: тесты одинаковы
 * под Bun, Deno и Node). Программа — `process.execPath`, а не имя из
 * `PATH`: тест, запущенный под Node, не должен требовать Deno на машине.
 *
 * Модуль подключают только тесты.
 */

import process from "node:process";

/**
 * Программа и аргументы запуска `module` с `args`: Node 24 и Bun
 * исполняют `.ts` сами, Deno — подкомандой `run` со всеми правами.
 */
export function runTs(
  module: string,
  args: readonly string[] = [],
): [string, string[]] {
  const run = process.versions.deno === undefined ? [] : ["run", "-A"];
  return [process.execPath, [...run, module, ...args]];
}
