/**
 * Запуск локального git для резолва MR-адреса. Отдельный файл, потому
 * что это единственное место атома, которому нужен процесс: тесты
 * подставляют свою `RunGit` и настоящий git не запускают вовсе.
 */

import { hasErrorCode } from "@mpu/base/oserror";
import { runProgram } from "../subprocess/mod.ts";
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
    const output = await runProgram("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return null;
    throw err;
  }
};
