/**
 * Чтение задачи сборки (`platform/monolith-removal.md`): права идут в
 * бинарь дословно, подменяются только путь вывода и два каталога
 * окружения; задачи нет — отказ с её именем, а не умолчание.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { BACK_TASK, compileArgs, CompileTaskError } from "./compile_task.ts";

const TARGET = {
  home: "/h",
  configHome: "/h/cfg",
  out: "/out/mpu",
} as const;

/** Задача той же формы, что настоящая, но короче. */
const TASK = `{
  "tasks": {
    "${BACK_TASK}": "deno compile --allow-write=$HOME/.config/mpu,$XDG_CONFIG_HOME/mpu --allow-run -o $MPU_OUT back/back.ts"
  }
}`;

Deno.test("аргументы задачи: права дословно, -o и каталоги подменены", () => {
  assertEquals(compileArgs(TASK, BACK_TASK, TARGET), [
    "compile",
    "--allow-write=/h/.config/mpu,/h/cfg/mpu",
    "--allow-run",
    "-o",
    "/out/mpu",
    "back/back.ts",
  ]);
});

Deno.test("задача не той формы — отказ с именем задачи", async (t) => {
  const cases = [
    {
      name: "задачи нет",
      text: `{ "tasks": { "test": "deno test" } }`,
      says: `в deno.jsonc нет задачи ${BACK_TASK}`,
    },
    {
      name: "в задаче нет -o",
      text: `{ "tasks": { "${BACK_TASK}": "deno compile back/back.ts" } }`,
      says: `в задаче ${BACK_TASK} нет -o`,
    },
  ];
  for (const { name, text, says } of cases) {
    await t.step(name, () => {
      assertThrows(
        () => compileArgs(text, BACK_TASK, TARGET),
        CompileTaskError,
        says,
      );
    });
  }
});

Deno.test("настоящая задача: путь вывода — только подставленный", async () => {
  const args = compileArgs(
    await Deno.readTextFile("deno.jsonc"),
    BACK_TASK,
    TARGET,
  );
  assertEquals(args[0], "compile");
  assertEquals(args[args.indexOf("-o") + 1], TARGET.out);
  assertEquals(
    args.some((arg) => arg.includes("$")),
    false,
    `осталась нераскрытая переменная: ${args.join(" ")}`,
  );
});

Deno.test("сборка никуда не устанавливает", async () => {
  // `-o` задачи — переменная прогона, а не путь установленной
  // программы: ставит программы `install.sh`, и сборка прогона их не
  // трогает (`platform/monolith-removal.md`).
  const source = await Deno.readTextFile("deno.jsonc");
  const task = source.match(
    new RegExp(`"${BACK_TASK}":\\s*"([^"]*)"`),
  )?.[1] ?? "";
  const words = task.split(/\s+/);
  assertEquals(words[words.indexOf("-o") + 1], "$MPU_OUT");
  assertEquals(task.includes(".local/bin"), false);
});
