/**
 * Права задач `complete` и `compile:complete` (`platform/reflection.md`,
 * «mpu-complete»; `design-mpu.md` п. 6): петля к `back`, чтение снимка и
 * основного токена, `HOME` и `MPU_BACK_URL`. Каждое право проверено
 * прогоном: процесс с флагами задачи из `deno.jsonc` отвечает вариантом,
 * которого нет в снимке, — значит, спросил `back`; без любого права он
 * падает, а не отвечает.
 */

import { assertEquals } from "@std/assert";
import { withBack } from "../../back/src/backend/testback.ts";

async function flags(task: string): Promise<string[]> {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(new RegExp(`"${task}": "([^"]*)"`))?.[1] ?? "";
  return line.split(/\s+/).filter((word) => word.startsWith("--allow")).sort();
}

const EXPECTED = [
  "--allow-env=HOME,MPU_BACK_URL",
  "--allow-net=127.0.0.1",
  "--allow-read=$HOME/.cache/mpu/tree.json,$HOME/.config/mpu/token",
];

Deno.test("права дополнения — петля, снимок, токен, HOME и адрес back", async () => {
  assertEquals(await flags("complete"), EXPECTED);
  assertEquals(await flags("compile:complete"), EXPECTED);
});

Deno.test("с правами задачи процесс спрашивает back: вариант не из снимка", () =>
  withBack(async (back) => {
    const home = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${home}/.config/mpu`, { recursive: true });
      await Deno.writeTextFile(`${home}/.config/mpu/token`, back.token);
      await Deno.mkdir(`${home}/.cache/mpu`, { recursive: true });
      await Deno.copyFile(
        new URL("testdata/complete/tree.json", import.meta.url),
        `${home}/.cache/mpu/tree.json`,
      );
      const granted = (await flags("complete")).map((flag) =>
        flag.replaceAll("$HOME", home)
      );
      const output = await new Deno.Command(Deno.execPath(), {
        args: ["run", ...granted, "complete/main.ts", "--", "xlsx", ""],
        env: { HOME: home, MPU_BACK_URL: back.url },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(output.code, 0, stderr);
      // В снимке-фикстуре ветки xlsx нет: варианты пришли от back.
      assertEquals(
        new TextDecoder().decode(output.stdout).split("\t")[0],
        "alias",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));
