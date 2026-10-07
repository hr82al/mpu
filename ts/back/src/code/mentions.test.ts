/**
 * `mpu code mentions` против golden-эталона спеки
 * (`specs/code-mentions.md`).
 *
 * Главное — строка существования: без неё перечень упоминаний одинаково
 * выглядит и для живого адреса, и для протухшего, а команда заводится
 * ровно ради второго.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
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
    await runMentions(
      { path, in: "fixture", limit },
      {
        cwd: () => repo.root,
      },
      [repo],
    ),
  );
}

it("mentions на дереве-фикстуре совпадает с голденом спеки", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    expect(await mentions(repo, "src/gone.ts")).toStrictEqual(
      await readFile(
        new URL("testdata/code/mentions-stale.stdout.txt", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("строка существования различает живой адрес и протухший", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("путь есть в коде и упомянут", async () => {
    const text = await mentions(repo, "src/days.ts");
    expect(text.includes("src/days.ts — есть в коде"), text).toBe(true);
    expect(text.includes("упоминания: 1"), text).toBe(true);
    expect(text.includes("  docs/guide.md:3"), text).toBe(true);
  });

  it("путь есть в коде и не упомянут", async () => {
    const text = await mentions(repo, "src/orphan.ts");
    expect(text.includes("src/orphan.ts — есть в коде"), text).toBe(true);
    expect(text.includes("упоминания: 0"), text).toBe(true);
  });

  it("гарантия всегда пониженная", async () => {
    // Команда работает по тексту документов и разбором не
    // притворяется — даже там, где разбор по типам возможен.
    const text = await mentions(repo, "src/days.ts");
    expect(
      text.startsWith("fixture · вне git · текстовый разбор — ответ неполон"),
      text,
    ).toBe(true);
  });
});

it("вхождение — пара «документ, строка»", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
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
    expect(result.sections[0].mentions.places).toStrictEqual([
      { path: "docs/guide.md", line: 3 },
      { path: "docs/guide.md", line: 5 },
    ]);
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("область просмотра — файлы .md вне node_modules", () => {
  let temp: string;
  let root: string;
  let repo: Repo;
  let result: {
    path: string;
    sections: {
      kind: "answer";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      exists: boolean;
      mentions: { total: number; places: { path: string; line: number }[] };
      unresolved: {
        total: number;
        items: {
          path: string;
          line: number;
          specifier: string;
          reason: string;
        }[];
      };
    }[];
  };
  let seen: string[];
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    root = `${temp}/r`;
    await mkdir(`${root}/.github`, { recursive: true });
    await mkdir(`${root}/node_modules/dep`, { recursive: true });
    await mkdir(`${root}/dist`, { recursive: true });
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/src/a.ts`, "export const a = 1;\n");
    // Документ в каталоге с точки — такой же документ. Общий обход
    // состава проекта режет каталоги с точки и `dist`, и просмотр по
    // нему сделал бы `.github/CONTRIBUTING.md` молча невидимым: ровно
    // тот класс дефекта, ради которого команда заводится.
    await writeFile(
      `${root}/.github/CONTRIBUTING.md`,
      "Правила лежат в `src/a.ts`.\n",
    );
    await writeFile(`${root}/dist/README.md`, "смотри src/a.ts\n");
    await writeFile(`${root}/node_modules/dep/README.md`, "чужой src/a.ts\n");
    repo = {
      name: "r",
      root,
      mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
    };
    result = await runMentions(
      { path: "src/a.ts", in: "r", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    seen = result.sections[0].mentions.places.map((place) => place.path);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("документ в каталоге с точки виден", () => {
    expect(seen.includes(".github/CONTRIBUTING.md"), `${seen}`).toBe(true);
  });

  it("зависимости не просматриваются", () => {
    expect(
      seen.some((path) => path.startsWith("node_modules/")),
      `${seen}`,
    ).toBe(false);
  });
});

it("путь, выходящий за корень, — ошибка ввода", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    // Иначе команда отвечает «есть в коде» про соседнее дерево под
    // отметкой этого — два дерева в одном ответе.
    const err = await rejected(
      () =>
        runMentions(
          {
            path: "../other/src/a.ts",
            in: "fixture",
            limit: 200,
          },
          {
            cwd: () => repo.root,
          },
          [repo],
        ),
      UsageError,
    );
    expect(err.message).toBe(
      "путь выходит за корень репозитория: '../other/src/a.ts'",
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("путь, свёрнутый в корень, — ошибка ввода", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    // Пустая строка совпадает с любой подстрокой: без этой проверки
    // команда объявляла упоминанием весь текст репозитория и печатала
    // строку существования с пустым именем.
    const err = await rejected(
      () =>
        runMentions(
          { path: "src/..", in: "fixture", limit: 200 },
          {
            cwd: () => repo.root,
          },
          [repo],
        ),
      UsageError,
    );
    expect(err.message).toBe("нужен путь внутри репозитория");
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("несуществующий каталог окна — ошибка ввода, а не ноль", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    // Иначе опечатка в имени каталога неотличима от «упоминаний нет» —
    // то самое молчание, ради которого семейство и заводится.
    const err = await rejected(
      () =>
        runMentions(
          {
            path: "src/days.ts",
            in: "fixture:nosuchdir",
            limit: 200,
          },
          {
            cwd: () => repo.root,
          },
          [repo],
        ),
      UsageError,
    );
    expect(err.message).toBe("каталога 'nosuchdir' нет в fixture на вне git");
  } finally {
    await rm(temp, { recursive: true });
  }
});
