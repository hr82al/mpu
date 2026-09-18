/**
 * Права задачи `cli` (`cli-client.md`, `design-mpu.md` п. 6): сеть петли,
 * чтение двух файлов токена, окружение `HOME` и `MPU_BACK_URL` — и ничего
 * больше. Клиент ничего не исполняет, и лишнее право было бы доступом,
 * которым он не пользуется.
 */

import { assertEquals } from "@std/assert";

Deno.test("права задачи cli — ровно три флага", async () => {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(/"cli": "([^"]*)"/)?.[1] ?? "";
  const flags = line.split(/\s+/).filter((arg) => arg.startsWith("--"));
  assertEquals(flags.sort(), [
    "--allow-env=HOME,MPU_BACK_URL",
    "--allow-net=127.0.0.1",
    "--allow-read=$HOME/.config/mpu/token,$HOME/.config/mpu/agent-token",
  ]);
  assertEquals(line.endsWith(" cli/main.ts"), true);
});
