/**
 * Права задачи `cli` (`cli-client.md`, `design-mpu.md` п. 6): сеть петли,
 * чтение двух файлов токена и управляющего терминала, запуск программ
 * копирования, окружение `HOME`, `MPU_BACK_URL` и имена контекста
 * вызова — и ничего больше. Клиент ничего не исполняет, и
 * лишнее право было бы доступом, которым он не пользуется.
 *
 * Имена окружения не перечислены здесь второй раз: они берутся из
 * единственного места (`CLIENT_ENV_NAMES`), и тест проверяет, что строка
 * задачи с ним сходится.
 */

import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CLIENT_ENV_NAMES } from "../../back/src/frames/mod.ts";
import { COPY_UTILITIES } from "./clipboard/mod.ts";

it("права задачи cli — ровно четыре флага", async () => {
  const denoJsonc = await readFile("deno.jsonc", "utf8");
  const line = denoJsonc.match(/"cli": "([^"]*)"/)?.[1] ?? "";
  const flags = line.split(/\s+/).filter((arg) => arg.startsWith("--"));
  expect(flags.sort()).toStrictEqual([
    `--allow-env=HOME,MPU_BACK_URL,${CLIENT_ENV_NAMES.join(",")}`,
    "--allow-net=127.0.0.1",
    "--allow-read=$HOME/.config/mpu/token,$HOME/.config/mpu/agent-token,/dev/tty",
    `--allow-run=${COPY_UTILITIES.join(",")}`,
  ]);
  expect(line.endsWith(" cli/main.ts")).toBe(true);
});
