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
 * Программа и аргументы запуска `module` с `args`, которые программа
 * получит дословно: Node 24 исполняет `.ts` сам; Deno — подкомандой
 * `run` со всеми правами; Bun — сам, но первый `--` после пути скрипта
 * забирает себе (проба 2026-10-07: `bun x.ts -- a` → `["a"]`), поэтому
 * аргументы отделяются своим `--`.
 */
export function runTs(
  module: string,
  args: readonly string[] = [],
): [string, string[]] {
  if (process.versions.deno !== undefined) {
    return [process.execPath, ["run", "-A", module, ...args]];
  }
  if (process.versions.bun !== undefined) {
    return [process.execPath, [module, "--", ...args]];
  }
  return [process.execPath, [module, ...args]];
}
