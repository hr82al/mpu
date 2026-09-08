/**
 * `mpu code mentions` против golden-эталона спеки
 * (`specs/code-mentions.md`).
 *
 * Главное — строка существования: без неё перечень упоминаний одинаково
 * выглядит и для живого адреса, и для протухшего, а команда заводится
 * ровно ради второго.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { renderMentions, runMentions } from "./cmd_mentions.ts";
import { openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

async function mentions(
  repo: Repo,
  path: string,
  limit = 200,
): Promise<string> {
  return renderMentions(
    await runMentions({ path, in: "fixture", limit }, {
      cwd: () => repo.root,
    }, [repo]),
  );
}

Deno.test("mentions на дереве-фикстуре совпадает с голденом спеки", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    assertEquals(
      await mentions(repo, "src/gone.ts"),
      await Deno.readTextFile(
        new URL("testdata/code/mentions-stale.stdout.txt", import.meta.url),
      ),
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("строка существования различает живой адрес и протухший", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);

    await t.step("путь есть в коде и упомянут", async () => {
      const text = await mentions(repo, "src/days.ts");
      assertEquals(text.includes("src/days.ts — есть в коде"), true, text);
      assertEquals(text.includes("упоминания: 1"), true, text);
      assertEquals(text.includes("  docs/guide.md:3"), true, text);
    });

    await t.step("путь есть в коде и не упомянут", async () => {
      const text = await mentions(repo, "src/orphan.ts");
      assertEquals(text.includes("src/orphan.ts — есть в коде"), true, text);
      assertEquals(text.includes("упоминания: 0"), true, text);
    });

    await t.step("гарантия всегда пониженная", async () => {
      // Команда работает по тексту документов и разбором не
      // притворяется — даже там, где разбор по типам возможен.
      const text = await mentions(repo, "src/days.ts");
      assertEquals(
        text.startsWith("fixture · вне git · текстовый разбор — ответ неполон"),
        true,
        text,
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("вхождение — пара «документ, строка»", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    // В `docs/guide.md` путь `src/gone.ts` встречается в строках 3 и 5;
    // в третьей строке он один. Считаются строки, а не вхождения:
    // править их будут вместе.
    const result = await runMentions(
      { path: "src/gone.ts", in: "fixture", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    assertEquals(
      result.sections[0].mentions.places,
      [
        { path: "docs/guide.md", line: 3 },
        { path: "docs/guide.md", line: 5 },
      ],
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("область просмотра — файлы .md вне node_modules", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/r`;
    await Deno.mkdir(`${root}/.github`, { recursive: true });
    await Deno.mkdir(`${root}/node_modules/dep`, { recursive: true });
    await Deno.mkdir(`${root}/dist`, { recursive: true });
    await Deno.mkdir(`${root}/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/src/a.ts`, "export const a = 1;\n");
    // Документ в каталоге с точки — такой же документ. Общий обход
    // состава проекта режет каталоги с точки и `dist`, и просмотр по
    // нему сделал бы `.github/CONTRIBUTING.md` молча невидимым: ровно
    // тот класс дефекта, ради которого команда заводится.
    await Deno.writeTextFile(
      `${root}/.github/CONTRIBUTING.md`,
      "Правила лежат в `src/a.ts`.\n",
    );
    await Deno.writeTextFile(`${root}/dist/README.md`, "смотри src/a.ts\n");
    await Deno.writeTextFile(
      `${root}/node_modules/dep/README.md`,
      "чужой src/a.ts\n",
    );
    const repo: Repo = {
      name: "r",
      root,
      mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
    };
    const result = await runMentions(
      { path: "src/a.ts", in: "r", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    const seen = result.sections[0].mentions.places.map((place) => place.path);

    await t.step("документ в каталоге с точки виден", () => {
      assertEquals(seen.includes(".github/CONTRIBUTING.md"), true, `${seen}`);
    });

    await t.step("зависимости не просматриваются", () => {
      assertEquals(
        seen.some((path) => path.startsWith("node_modules/")),
        false,
        `${seen}`,
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("путь, выходящий за корень, — ошибка ввода", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    // Иначе команда отвечает «есть в коде» про соседнее дерево под
    // отметкой этого — два дерева в одном ответе.
    const err = await assertRejects(
      () =>
        runMentions({ path: "../other/src/a.ts", in: "fixture", limit: 200 }, {
          cwd: () => repo.root,
        }, [repo]),
      UsageError,
    );
    assertEquals(
      err.message,
      "путь выходит за корень репозитория: '../other/src/a.ts'",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("путь, свёрнутый в корень, — ошибка ввода", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    // Пустая строка совпадает с любой подстрокой: без этой проверки
    // команда объявляла упоминанием весь текст репозитория и печатала
    // строку существования с пустым именем.
    const err = await assertRejects(
      () =>
        runMentions({ path: "src/..", in: "fixture", limit: 200 }, {
          cwd: () => repo.root,
        }, [repo]),
      UsageError,
    );
    assertEquals(err.message, "в пути нет файла: 'src/..'");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("несуществующий каталог окна — ошибка ввода, а не ноль", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    // Иначе опечатка в имени каталога неотличима от «упоминаний нет» —
    // то самое молчание, ради которого семейство и заводится.
    const err = await assertRejects(
      () =>
        runMentions({
          path: "src/days.ts",
          in: "fixture:nosuchdir",
          limit: 200,
        }, {
          cwd: () => repo.root,
        }, [repo]),
      UsageError,
    );
    assertEquals(
      err.message,
      "каталога 'nosuchdir' нет в fixture на вне git",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
