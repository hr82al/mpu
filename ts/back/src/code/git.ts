/**
 * Запуск локального git для отметки дерева. Отдельный файл, потому что
 * это единственное место слоя, которому нужен процесс: тесты
 * подставляют постоянную отметку и настоящий git не запускают вовсе.
 */

import { runProgram } from "../subprocess/mod.ts";
import type { RunGit } from "./mark.ts";

/**
 * Запуск `git <args>` в каталоге репозитория. `null` — запустить git не
 * удалось: дерево, о котором он ничего не может сказать, получает
 * отметку `вне git`, а не отказ (`platform/code-analyzer.md`).
 *
 * Причин у неудачи больше одной, и все означают одно и то же: бинаря
 * нет в `PATH` (`ENOENT`), самого `PATH` нет в окружении, файл не
 * исполняемый (`EACCES`). Все дают ответ, а не отказ.
 */
export const spawnGit: RunGit = async (args, cwd) => {
  const decoder = new TextDecoder();
  try {
    const output = await runProgram("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    return { code: output.code, stdout: decoder.decode(output.stdout) };
  } catch {
    // Любой отказ запуска — «вне git» (см. выше).
    return null;
  }
};
