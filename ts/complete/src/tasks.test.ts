/**
 * Права задач `complete` и `compile:complete` (`platform/reflection.md`,
 * «mpu-complete»; `design-mpu.md` п. 6): петля к `back`, чтение снимка и
 * основного токена, `HOME` и `MPU_BACK_URL`. Каждое право проверено
 * прогоном: процесс с флагами задачи из `deno.jsonc` отвечает вариантом,
 * которого нет в снимке, — значит, спросил `back`; без любого права он
 * падает, а не отвечает.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withBack } from "../../back/src/backend/testback.ts";

async function flags(task: string): Promise<string[]> {
  const denoJsonc = await readFile("deno.jsonc", "utf8");
  const line = denoJsonc.match(new RegExp(`"${task}": "([^"]*)"`))?.[1] ?? "";
  return line.split(/\s+/).filter((word) => word.startsWith("--allow")).sort();
}

const EXPECTED = [
  "--allow-env=HOME,MPU_BACK_URL",
  "--allow-net=127.0.0.1",
  "--allow-read=$HOME/.cache/mpu/tree.json,$HOME/.config/mpu/token",
];

it("права дополнения — петля, снимок, токен, HOME и адрес back", async () => {
  expect(await flags("complete")).toStrictEqual(EXPECTED);
  expect(await flags("compile:complete")).toStrictEqual(EXPECTED);
});

it("с правами задачи процесс спрашивает back: вариант не из снимка", () =>
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
      const granted = (await flags("complete")).map((flag) =>
        flag.replaceAll("$HOME", home)
      );
      // Окружение — только эти две переменные: `env` у `execFile`
      // заменяет унаследованное. Ненулевой выход — отказ с stderr в тексте.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["run", ...granted, "complete/main.ts", "--", "xlsx", ""],
        { env: { HOME: home, MPU_BACK_URL: back.url } },
      );
      // В снимке-фикстуре ветки xlsx нет: варианты пришли от back.
      expect(stdout.split("\t")[0]).toBe("alias");
    } finally {
      await rm(home, { recursive: true });
    }
  }));
