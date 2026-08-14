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
import { type CommandIo, NotFoundIoError } from "../command/mod.ts";

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

Deno.test("--install-completion дописывает скрипт в rc-файл", async (t) => {
  const dir = await Deno.makeTempDir();
  const io: Partial<CommandIo> = {
    env: (name) => (name === "HOME" ? dir : undefined),
    readTextFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          throw new NotFoundIoError("нет файла", { cause: err });
        }
        throw err;
      }
    },
    appendFile: (path, text) =>
      Deno.writeTextFile(path, text, { append: true, create: true }),
  };
  try {
    await t.step("первый запуск создаёт файл", async () => {
      const { code, stdout } = await run(["--install-completion", "zsh"], io);
      assertEquals(code, 0);
      assertStringIncludes(stdout, `${dir}/.zshrc`);
      assertStringIncludes(await Deno.readTextFile(`${dir}/.zshrc`), "compdef");
    });

    await t.step("повторный не плодит вторую копию", async () => {
      const before = await Deno.readTextFile(`${dir}/.zshrc`);
      const { code, stdout } = await run(["--install-completion", "zsh"], io);
      assertEquals(code, 0);
      assertStringIncludes(stdout, "уже установлен");
      assertEquals(await Deno.readTextFile(`${dir}/.zshrc`), before);
    });
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

  await t.step("zsh: хвостовой пробел — курсор на новом слове", async () => {
    // У zsh нет COMP_CWORD: то, что слово ещё не начато, видно только
    // по пробелу в конце строки.
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_zsh"
          : name === "_TYPER_COMPLETE_ARGS"
          ? "mpu xlsx "
          : undefined,
    });
    assertStringIncludes(stdout, "_arguments '*: :((");
    assertStringIncludes(stdout, '"alias":"');
    // Без пробела то же самое слово дополняется как частичное.
    const partial = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_zsh"
          : name === "_TYPER_COMPLETE_ARGS"
          ? "mpu xlsx"
          : undefined,
    });
    assertStringIncludes(partial.stdout, '"xlsx":"');
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
    assertStringIncludes(stdout, '"xlsx":"');
  });

  await t.step("после имени группы — её подкоманды", async () => {
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_bash"
          : name === "COMP_WORDS"
          ? "mpu xlsx a"
          : name === "COMP_CWORD"
          ? "2"
          : undefined,
    });
    // Дополняется уровень, до которого дошли, а не корень дерева.
    assertEquals(stdout.split("\n").filter(Boolean), ["alias"]);
  });

  await t.step("частично переехавшая группа — её native-листья", async () => {
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_bash"
          : name === "COMP_WORDS"
          ? "mpu kiten"
          : name === "COMP_CWORD"
          ? "2"
          : undefined,
    });
    // Список неполон по построению: соседи `card` в реестре не заведены —
    // слепок отдаёт группу одной записью, и до конца переезда дополнение
    // внутри неё видит только переехавшие листья (`platform/registry.md`).
    assertEquals(stdout.split("\n").filter(Boolean), ["card"]);
  });

  await t.step("курсор после пробела — весь уровень целиком", async () => {
    const { stdout } = await run([], {
      env: (name) =>
        name === "_MPU_COMPLETE"
          ? "complete_bash"
          : name === "COMP_WORDS"
          ? "mpu xlsx"
          : name === "COMP_CWORD"
          ? "2"
          : undefined,
    });
    const lines = stdout.split("\n").filter(Boolean);
    assertEquals(lines.includes("ls"), true);
    assertEquals(lines.includes("alias"), true);
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
