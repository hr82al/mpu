/**
 * `mpu code name` против golden-эталонов спеки (`specs/code-name.md`).
 *
 * Главное здесь — что в перечень попадают объявления ЛЮБОЙ формы: на
 * фикстуре один тёзка объявлен `function`, другой стрелкой, и текстовый
 * поиск по `function spanDays` второго не находит вовсе. Это одна из
 * причин, ради которых команда заводится.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { codeNameCommand, renderName, runName } from "./cmd_name.ts";
import { openBrokenFixture, openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

async function name(
  repo: Repo,
  what: string,
  where: string | undefined = "fixture",
  limit = 200,
): Promise<string> {
  return renderName(
    await runName({ name: what, in: where, limit }, { cwd: () => repo.root }, [
      repo,
    ]),
  );
}

async function golden(file: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`testdata/code/${file}`, import.meta.url),
  );
}

Deno.test("name на дереве-фикстуре совпадает с голденами спеки", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const cases: readonly (readonly [string, string])[] = [
      ["spanDays", "name-collision.stdout.txt"],
      ["nothingHere", "name-empty.stdout.txt"],
    ];
    for (const [what, file] of cases) {
      await t.step(file, async () => {
        assertEquals(await name(repo, what), await golden(file));
      });
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("окно уровня каталога сужает ответ", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);

    await t.step("оба тёзки лежат в src", async () => {
      const text = await name(repo, "spanDays", "fixture:src");
      assertEquals(text.includes("объявления: 2"), true, text);
    });

    await t.step("каталог есть, разбираемых файлов в нём нет", async () => {
      // `docs` на диске есть, но в программу не входит ни один его
      // файл. Это ответ «имя здесь свободно», а не «каталога нет»:
      // существование каталога решает диск, а не состав программы.
      const text = await name(repo, "spanDays", "fixture:docs");
      assertEquals(text.includes("объявления: 0"), true, text);
    });

    await t.step("каталога нет — ошибка ввода, а не пустой ответ", async () => {
      const err = await assertRejects(
        () => name(repo, "spanDays", "fixture:nowhere"),
        UsageError,
      );
      assertEquals(err.message, "каталога 'nowhere' нет в fixture на вне git");
    });

    await t.step("окно, выходящее за корень, — ошибка ввода", async () => {
      // `src/..` — это корень репозитория, а не каталог `src/..`:
      // без нормализации префикс не совпадал ни с чем, и ответом
      // становилось честное на вид «имя свободно» там, где имя занято
      // дважды.
      for (const raw of ["fixture:..", "fixture:src/../.."]) {
        const err = await assertRejects(
          () => name(repo, "spanDays", raw),
          UsageError,
        );
        assertEquals(
          err.message,
          `каталог окна выходит за корень репозитория: '${raw}'`,
        );
      }
    });

    await t.step(
      "окно, свёрнутое в корень, отвечает как весь репозиторий",
      async () => {
        const text = await name(repo, "spanDays", "fixture:src/..");
        assertEquals(text.includes("объявления: 2"), true, text);
      },
    );

    await t.step("неизвестный репозиторий окна", async () => {
      const err = await assertRejects(
        () => name(repo, "spanDays", "nope"),
        UsageError,
      );
      assertEquals(err.message, "неизвестный репозиторий 'nope'");
      assertEquals(err.details, "  fixture");
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("строка типов возврата: при двух объявлениях и с пометкой", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);

    await t.step("одно объявление — строки нет", async () => {
      const text = await name(repo, "addDays");
      assertEquals(text.includes("объявления: 1"), true, text);
      assertEquals(text.includes("типы возврата"), false, text);
    });

    await t.step("два с одним типом — без пометки", async () => {
      const text = await name(repo, "spanDays");
      assertEquals(text.includes("типы возврата: number\n"), true, text);
      assertEquals(text.includes("различаются"), false, text);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("тёзки с разными типами возврата помечаются явно", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/r`;
    await Deno.mkdir(`${root}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/tsconfig.json`,
      '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
    );
    // Два тёзки одного имени с разными типами возврата — случай, ради
    // которого команда и заводится: компилятор о нём не спросит.
    await Deno.writeTextFile(
      `${root}/src/a.ts`,
      "export function span(n: number): number {\n  return n;\n}\n",
    );
    await Deno.writeTextFile(
      `${root}/src/b.ts`,
      "export const span = (n: number): string => String(n);\n",
    );
    const repo: Repo = {
      name: "r",
      root,
      mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
    };
    const text = await name(repo, "span", "r");
    assertEquals(
      text.includes("типы возврата: number, string — различаются"),
      true,
      text,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("репозиторий без проектов: объявлений нет — отказ", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/plain`;
    await Deno.mkdir(`${root}/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/src/a.ts`, "export const one = 1;\n");
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // `объявления: 0` читалось бы как «имя свободно», а это другой ответ.
    const err = await assertRejects(
      () => name(repo, "one", "plain"),
      DomainError,
    );
    assertEquals(
      err.message,
      "объявления не разбираются текстовым анализатором: " +
        "в репозитории plain нет ни одного проекта",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("тёзки, ни один из которых не вызывается", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await plainProject(`${temp}/r`, {
      "src/a.ts": "export const LIMIT = 1;\n",
      "src/b.ts": "export const LIMIT = 2;\n",
    });
    // Объявлений два, вызываемых ноль: вопрос «не разошлись ли
    // возвраты» не возникает, и строки типов возврата быть не должно.
    const text = await name(repo, "LIMIT", "r");
    assertEquals(text.includes("объявления: 2"), true, text);
    assertEquals(text.includes("типы возврата"), false, text);
    // Раздела соседей тоже нет: образца сигнатуры взять неоткуда, а
    // «та же сигнатура, другое имя: 0» утверждало бы, что соседей нет.
    assertEquals(text.includes("та же сигнатура"), false, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("один вызываемый тёзка из трёх — строки типов возврата нет", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await plainProject(`${temp}/r`, {
      "src/a.ts": "export const SPAN = 1;\n",
      "src/b.ts": "export const SPAN = 2;\n",
      "src/c.ts": "export function SPAN(): number {\n  return 3;\n}\n",
    });
    // Объявлений три, вызываемое одно: сравнивать возвраты не с чем, и
    // строка с единственным типом читалась бы как «все возвращают
    // number», что неправда.
    const text = await name(repo, "SPAN", "r");
    assertEquals(text.includes("объявления: 3"), true, text);
    assertEquals(text.includes("типы возврата"), false, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("пустой репозиторий без проектов — отказ, а не «имя свободно»", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/plain`;
    await Deno.mkdir(root, { recursive: true });
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // Ни одного файла кода: перечень пуст по обеим причинам сразу, и
    // отказ обязан решаться до сбора файлов, иначе ответом станет
    // «объявления: 0».
    const err = await assertRejects(
      () => name(repo, "anything", "plain"),
      DomainError,
    );
    assertEquals(
      err.message,
      "объявления не разбираются текстовым анализатором: " +
        "в репозитории plain нет ни одного проекта",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("два репозитория — два раздела, разделённых пустой строкой", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const first = await plainProject(`${temp}/one`, {
      "src/a.ts": "export function shared(): number {\n  return 1;\n}\n",
    });
    const second = await plainProject(`${temp}/two`, {
      "src/a.ts": "export function shared(): string {\n  return '';\n}\n",
    });
    const result = await runName(
      { name: "shared", in: undefined, limit: 200 },
      { cwd: () => first.root },
      [{ ...first, name: "one" }, { ...second, name: "two" }],
    );
    const text = renderName(result);
    // Разделы не смешиваются и не слипаются: между ними ровно одна
    // пустая строка, а хвостовой перевод один на весь ответ.
    assertEquals(result.sections.length, 2, text);
    assertEquals(text.includes("\n\n\n"), false, JSON.stringify(text));
    assertEquals(
      text.endsWith("не разрешено: 0\n"),
      true,
      JSON.stringify(text),
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

/** Репозиторий с tsconfig-проектом из заданных файлов. */
async function plainProject(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Repo> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/tsconfig.json`,
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  );
  for (const [path, text] of Object.entries(files)) {
    await Deno.writeTextFile(`${root}/${path}`, text);
  }
  const name = root.slice(root.lastIndexOf("/") + 1);
  return {
    name,
    root,
    mark: () => Promise.resolve({ repo: name, state: { kind: "out-of-git" } }),
  };
}

Deno.test("отказ одного репозитория не отменяет ответы остальных", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const broken = await openBrokenFixture(temp);
    const working = await plainProject(`${temp}/works`, {
      "src/a.ts":
        "export function alpha(day: string): string {\n  return day;\n}\n",
    });
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => working.root },
      [broken, working],
    );
    const text = renderName(result);

    await t.step("отказавший раздел назвал причину", () => {
      // У отказавшего раздела ни гарантии, ни перечней нет по типу:
      // состояния «отказ и при этом перечень» не существует.
      assertEquals(result.sections[0].kind, "refused", text);
      assertEquals(
        text.includes("  отказ: конфигурация проекта tsconfig.json"),
        true,
        text,
      );
    });

    await t.step("соседний раздел ответил", () => {
      // Замер спецификатора: один репозиторий без установленных
      // зависимостей обнулял ответ по всем восьми.
      const answered = result.sections[1];
      assertEquals(answered.kind, "answer", text);
      if (answered.kind !== "answer") return;
      assertEquals(answered.declarations.total, 1, text);
    });

    await t.step("ответил хотя бы один — код выхода нулевой", () => {
      assertEquals(codeNameCommand.textExitCode(result), 0, text);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("не ответил ни один раздел — код выхода единица", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const broken = await openBrokenFixture(temp);
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => broken.root },
      [broken],
    );
    // Отказ раздела и отказ команды — разное; совпадают они только
    // когда раздел один (`platform/code-analyzer.md`).
    assertEquals(codeNameCommand.textExitCode(result), 1);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
