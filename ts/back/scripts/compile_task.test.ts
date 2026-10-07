/**
 * Чтение задачи сборки (`platform/monolith-removal.md`): права идут в
 * бинарь дословно, подменяются только путь вывода и два каталога
 * окружения; задачи нет — отказ с её именем, а не умолчание.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { thrown } from "../src/testing/thrown.ts";
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

it("аргументы задачи: права дословно, -o и каталоги подменены", () => {
  expect(compileArgs(TASK, BACK_TASK, TARGET)).toStrictEqual([
    "compile",
    "--allow-write=/h/.config/mpu,/h/cfg/mpu",
    "--allow-run",
    "-o",
    "/out/mpu",
    "back/back.ts",
  ]);
});

describe("задача не той формы — отказ с именем задачи", () => {
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
    it(name, () => {
      thrown(
        () => compileArgs(text, BACK_TASK, TARGET),
        CompileTaskError,
        says,
      );
    });
  }
});

it("настоящая задача: путь вывода — только подставленный", async () => {
  const args = compileArgs(
    await readFile("deno.jsonc", "utf8"),
    BACK_TASK,
    TARGET,
  );
  expect(args[0]).toBe("compile");
  expect(args[args.indexOf("-o") + 1]).toStrictEqual(TARGET.out);
  expect(
    args.some((arg) => arg.includes("$")),
    `осталась нераскрытая переменная: ${args.join(" ")}`,
  ).toBe(false);
});

it("сборка никуда не устанавливает", async () => {
  // `-o` задачи — переменная прогона, а не путь установленной
  // программы: ставит программы `install.sh`, и сборка прогона их не
  // трогает (`platform/monolith-removal.md`).
  const source = await readFile("deno.jsonc", "utf8");
  const task = source.match(
    new RegExp(`"${BACK_TASK}":\\s*"([^"]*)"`),
  )?.[1] ?? "";
  const words = task.split(/\s+/);
  expect(words[words.indexOf("-o") + 1]).toBe("$MPU_OUT");
  expect(task.includes(".local/bin")).toBe(false);
});
