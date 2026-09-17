/**
 * Запуск локального git для отметки дерева. Отдельный файл, потому что
 * это единственное место слоя, которому нужен процесс: тесты
 * подставляют постоянную отметку и настоящий git не запускают вовсе.
 */

import type { RunGit } from "./mark.ts";

/**
 * Запуск `git <args>` в каталоге репозитория. `null` — запустить git не
 * удалось: дерево, о котором он ничего не может сказать, получает
 * отметку `вне git`, а не отказ (`platform/code-analyzer.md`).
 *
 * Причин у неудачи больше одной, и типом они не различаются: бинаря нет
 * в `PATH` (`Deno.errors.NotFound`) и самого `PATH` нет в окружении
 * (обычный `Error` с текстом «no path to search» — замер 2026-09-08).
 * Обе означают одно и то же и обе дают ответ. Единственная, которая
 * обязана прорваться наружу, — нехватка права `--allow-run`: она
 * значит, что бинарь собран неверно, и молчаливое «вне git» скрыло бы
 * это от smoke.
 */
export const spawnGit: RunGit = async (args, cwd) => {
  const decoder = new TextDecoder();
  try {
    const output = await new Deno.Command("git", {
      args: [...args],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return { code: output.code, stdout: decoder.decode(output.stdout) };
  } catch (err) {
    if (err instanceof Deno.errors.NotCapable) throw err;
    return null;
  }
};
