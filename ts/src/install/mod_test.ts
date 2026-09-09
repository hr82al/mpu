import { assert, assertEquals, assertThrows } from "@std/assert";
import { BuildTaskError, compileArgs, installedBinPath } from "./mod.ts";

const TARGET = {
  home: "/h",
  configHome: "/h/cfg",
  out: "/out/mpu",
} as const;

/** Задача той же формы, что настоящая, но короче: разбор к длине не чувствителен. */
const TASK = `{
  "tasks": {
    "build": "deno compile --allow-write=$HOME/.config/mpu,$XDG_CONFIG_HOME/mpu --allow-run -o $HOME/.local/bin/mpu main.ts"
  }
}`;

Deno.test("аргументы задачи build: права дословно, -o и каталоги подменены", () => {
  assertEquals(compileArgs(TASK, TARGET), [
    "compile",
    "--allow-write=/h/.config/mpu,/h/cfg/mpu",
    "--allow-run",
    "-o",
    "/out/mpu",
    "main.ts",
  ]);
});

Deno.test("задача не той формы — отказ, а не молчаливое умолчание", async (t) => {
  const cases = [
    { name: "задачи нет", text: `{ "tasks": { "test": "deno test" } }` },
    {
      name: "в задаче нет -o",
      text: `{ "tasks": { "build": "deno compile main.ts" } }`,
    },
  ];
  for (const { name, text } of cases) {
    await t.step(name, () => {
      assertThrows(() => compileArgs(text, TARGET), BuildTaskError);
    });
  }
});

Deno.test("настоящая задача build: путь вывода — только подставленный", async () => {
  const args = compileArgs(await Deno.readTextFile("deno.jsonc"), TARGET);
  assertEquals(args[0], "compile");
  assertEquals(args[args.indexOf("-o") + 1], TARGET.out);
  assertEquals(
    args.some((arg) => arg.includes("$")),
    false,
    `осталась нераскрытая переменная: ${args.join(" ")}`,
  );
});

Deno.test("путь установки записан одинаково в задаче build и в коде", async () => {
  // Два места знают один путь: значение `-o` задачи читает `deno task`,
  // а `installedBinPath` — команда `mpu build` и описание службы.
  // Разъехавшись, они поставили бы программу не туда, куда смотрит
  // служба, и заметить это было бы некому.
  const source = await Deno.readTextFile("deno.jsonc");
  const task = source.match(/"build":\s*"([^"]*)"/)?.[1];
  assert(task !== undefined, "в deno.jsonc нет задачи build");
  const words = task.split(/\s+/);
  assertEquals(
    words[words.indexOf("-o") + 1],
    installedBinPath("$HOME"),
    "значение -o задачи build разошлось с installedBinPath",
  );
});
