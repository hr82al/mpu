/**
 * Чтение задачи сборки монолита (`platform/cutover.md`): права идут в
 * бинарь дословно, подменяются только путь вывода и два каталога
 * окружения; задачи нет — отказ с её именем, а не умолчание.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  compileArgs,
  CompileTaskError,
  MONOLITH_TASK,
} from "./compile_task.ts";

const TARGET = {
  home: "/h",
  configHome: "/h/cfg",
  out: "/out/mpu",
} as const;

/** Задача той же формы, что настоящая, но короче. */
const TASK = `{
  "tasks": {
    "${MONOLITH_TASK}": "deno compile --allow-write=$HOME/.config/mpu,$XDG_CONFIG_HOME/mpu --allow-run -o $MPU_OUT back/main.ts"
  }
}`;

Deno.test("аргументы задачи: права дословно, -o и каталоги подменены", () => {
  assertEquals(compileArgs(TASK, TARGET), [
    "compile",
    "--allow-write=/h/.config/mpu,/h/cfg/mpu",
    "--allow-run",
    "-o",
    "/out/mpu",
    "back/main.ts",
  ]);
});

Deno.test("задача не той формы — отказ с именем задачи", async (t) => {
  const cases = [
    {
      name: "задачи нет",
      text: `{ "tasks": { "test": "deno test" } }`,
      says: `в deno.jsonc нет задачи ${MONOLITH_TASK}`,
    },
    {
      name: "в задаче нет -o",
      text: `{ "tasks": { "${MONOLITH_TASK}": "deno compile back/main.ts" } }`,
      says: `в задаче ${MONOLITH_TASK} нет -o`,
    },
  ];
  for (const { name, text, says } of cases) {
    await t.step(name, () => {
      assertThrows(() => compileArgs(text, TARGET), CompileTaskError, says);
    });
  }
});

Deno.test("настоящая задача: путь вывода — только подставленный", async () => {
  const args = compileArgs(await Deno.readTextFile("deno.jsonc"), TARGET);
  assertEquals(args[0], "compile");
  assertEquals(args[args.indexOf("-o") + 1], TARGET.out);
  assertEquals(
    args.some((arg) => arg.includes("$")),
    false,
    `осталась нераскрытая переменная: ${args.join(" ")}`,
  );
});

Deno.test("сборка монолита никуда не устанавливает", async () => {
  // `-o` задачи — переменная прогона, а не путь установленной
  // программы: после переключения там лежит клиент, и сборка монолита
  // его не трогает (`platform/cutover.md`).
  const source = await Deno.readTextFile("deno.jsonc");
  const task = source.match(
    new RegExp(`"${MONOLITH_TASK}":\\s*"([^"]*)"`),
  )?.[1] ?? "";
  const words = task.split(/\s+/);
  assertEquals(words[words.indexOf("-o") + 1], "$MPU_OUT");
  assertEquals(task.includes(".local/bin"), false);
});
