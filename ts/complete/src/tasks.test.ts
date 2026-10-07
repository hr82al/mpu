/**
 * Процесс `mpu-complete` (`platform/reflection.md`, «mpu-complete»):
 * с основным токеном и адресом `back` он отвечает вариантом, которого
 * нет в снимке, — значит, спросил `back`.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withBack } from "../../back/src/backend/testback.ts";
import { runTs } from "../../back/src/testing/runts.ts";

it("процесс дополнения спрашивает back: вариант не из снимка", () =>
  withBack(async (back) => {
    const home = await mkdtemp(join(tmpdir(), "mpu-"));
    try {
      await mkdir(`${home}/.config/mpu`, { recursive: true });
      await writeFile(`${home}/.config/mpu/token`, back.token);
      await mkdir(`${home}/.cache/mpu`, { recursive: true });
      await copyFile(
        new URL("testdata/complete/tree.json", import.meta.url),
        `${home}/.cache/mpu/tree.json`,
      );
      // Окружение — только эти две переменные: `env` у `execFile`
      // заменяет унаследованное. Ненулевой выход — отказ с stderr в тексте.
      const { stdout } = await promisify(execFile)(
        ...runTs("complete/main.ts", ["--", "xlsx", ""]),
        { env: { HOME: home, MPU_BACK_URL: back.url } },
      );
      // В снимке-фикстуре ветки xlsx нет: варианты пришли от back.
      expect(stdout.split("\t")[0]).toBe("alias");
    } finally {
      await rm(home, { recursive: true });
    }
  }));
