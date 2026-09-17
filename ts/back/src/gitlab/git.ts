/**
 * Запуск локального git для резолва MR-адреса. Отдельный файл, потому
 * что это единственное место атома, которому нужен процесс: тесты
 * подставляют свою `RunGit` и настоящий git не запускают вовсе
 * (в прогоне тестов `--allow-run` ограничен списком путей).
 */

import type { GitOutcome, RunGit } from "./resolve.ts";

/**
 * Запуск `git <args>` в каталоге вызова. `null` — исполняемого файла
 * нет в PATH: у спеки это отдельный исход со своим текстом, а не
 * ненулевой код возврата.
 */
export const spawnGit: RunGit = async (
  args: readonly string[],
  cwd: string,
): Promise<GitOutcome | null> => {
  const decoder = new TextDecoder();
  try {
    const output = await new Deno.Command("git", {
      args: [...args],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
};
