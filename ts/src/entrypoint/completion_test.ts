/**
 * Shell-completion (`platform/registry.md`) против эталонов
 * `completion-bash.txt` и `completion-zsh.txt`.
 *
 * Что проверяемо из сессии: генерация скрипта по явно заданному shell,
 * установка в rc-файл, режим выдачи вариантов и то, что переменная
 * `SHELL` в выборе не участвует. Определение shell по дереву
 * процессов-предков проверяет оператор: подменить дерево предков из
 * теста нечем.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { completionScript } from "./completion.ts";
import { childrenOf } from "../registry/mod.ts";
import type { CommandIo } from "../command/mod.ts";

async function run(
  argv: readonly string[],
  overrides: Partial<CommandIo> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, makeFakeIo(overrides), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

const golden = (shell: string) =>
  Deno.readTextFile(
    new URL(`../registry/testdata/completion-${shell}.txt`, import.meta.url),
  );

Deno.test("--show-completion печатает скрипт эталона", async (t) => {
  for (const shell of ["bash", "zsh"]) {
    await t.step(shell, async () => {
      const { code, stdout, stderr } = await run(["--show-completion", shell]);
      assertEquals(code, 0);
      assertEquals(stderr, "");
      // Скрипт попадает в rc-файл пользователя: здесь байтовая сверка
      // уместна — расхождение означало бы другое поведение установки.
      assertEquals(stdout, await golden(shell));
      assertEquals(stdout, completionScript(shell === "bash" ? "bash" : "zsh"));
    });
  }
});

Deno.test("переменная SHELL в выборе не участвует", async () => {
  // При bash-родителе и SHELL=/bin/zsh нужен bash-скрипт (спека).
  const { stdout } = await run(["--show-completion", "bash"], {
    env: (name) => (name === "SHELL" ? "/bin/zsh" : undefined),
  });
  assertEquals(stdout, await golden("bash"));
});

Deno.test("shell не определён и не задан — понятный отказ", async () => {
  const { code, stderr } = await run(["--show-completion"], {
    currentShell: () => undefined,
  });
  assertEquals(code, 2);
  assertStringIncludes(stderr, "неизвестный shell");
});

Deno.test("--install-completion дописывает скрипт в rc-файл", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { code, stdout } = await run(["--install-completion", "zsh"], {
      env: (name) => (name === "HOME" ? dir : undefined),
      appendFile: (path, text) =>
        Deno.writeTextFile(path, text, { append: true, create: true }),
    });
    assertEquals(code, 0);
    assertStringIncludes(stdout, `${dir}/.zshrc`);
    assertStringIncludes(await Deno.readTextFile(`${dir}/.zshrc`), "compdef");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("установка без HOME — отказ, а не запись мимо", async () => {
  const { code, stderr } = await run(["--install-completion", "bash"], {
    env: () => undefined,
  });
  assertEquals(code, 1);
  assertStringIncludes(stderr, "HOME не задан");
});

Deno.test("shell берётся от окружения, когда аргумента нет", async () => {
  const { code, stdout } = await run(["--show-completion"], {
    currentShell: () => "zsh",
  });
  assertEquals(code, 0);
  assertStringIncludes(stdout, "#compdef mpu");
});

Deno.test("режим дополнения печатает варианты, а не справку", async (t) => {
  const names = childrenOf([]).map((child) => child.name);

  await t.step("bash: по строке на вариант", async () => {
    const { code, stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_bash"
          : name === "COMP_WORDS"
          ? "mpu sq"
          : undefined,
    });
    assertEquals(code, 0);
    const lines = stdout.split("\n").filter(Boolean);
    assertEquals(lines.includes("sql"), true);
    assertEquals(lines.includes("sql-ro"), true);
    // Только подходящие: индекс команд сюда не печатается.
    assertEquals(lines.every((line) => line.startsWith("sq")), true);
    assertEquals(lines.length < names.length, true);
  });

  await t.step("zsh: вывод — код для eval", async () => {
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_zsh"
          : name === "_TYPER_COMPLETE_ARGS"
          ? "mpu xl"
          : undefined,
    });
    assertStringIncludes(stdout, "compadd -- xlsx");
  });

  await t.step("пустое слово — все имена верхнего уровня", async () => {
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_bash"
          : name === "COMP_WORDS"
          ? "mpu"
          : undefined,
    });
    assertEquals(stdout.split("\n").filter(Boolean).length, names.length);
  });
});
