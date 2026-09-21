/**
 * Права задачи `cli` (`cli-client.md`, `design-mpu.md` п. 6): сеть петли,
 * чтение двух файлов токена, окружение `HOME`, `MPU_BACK_URL` и имена
 * контекста вызова — и ничего больше. Клиент ничего не исполняет, и
 * лишнее право было бы доступом, которым он не пользуется.
 *
 * Имена окружения не перечислены здесь второй раз: они берутся из
 * единственного места (`CLIENT_ENV_NAMES`), и тест проверяет, что строка
 * задачи с ним сходится.
 */

import { assertEquals } from "@std/assert";
import { CLIENT_ENV_NAMES } from "../../back/src/frames/mod.ts";

Deno.test("права задачи cli — ровно три флага", async () => {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(/"cli": "([^"]*)"/)?.[1] ?? "";
  const flags = line.split(/\s+/).filter((arg) => arg.startsWith("--"));
  assertEquals(flags.sort(), [
    `--allow-env=HOME,MPU_BACK_URL,${CLIENT_ENV_NAMES.join(",")}`,
    "--allow-net=127.0.0.1",
    "--allow-read=$HOME/.config/mpu/token,$HOME/.config/mpu/agent-token",
  ]);
  assertEquals(line.endsWith(" cli/main.ts"), true);
});
