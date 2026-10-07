/**
 * `mpu code name` против golden-эталонов спеки (`specs/code-name.md`).
 *
 * Главное здесь — что в перечень попадают объявления ЛЮБОЙ формы: на
 * фикстуре один тёзка объявлен `function`, другой стрелкой, и текстовый
 * поиск по `function spanDays` второго не находит вовсе. Это одна из
 * причин, ради которых команда заводится.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
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
  return await readFile(
    new URL(`testdata/code/${file}`, import.meta.url),
    "utf8",
  );
}

describe("name на дереве-фикстуре совпадает с голденами спеки", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  const cases: readonly (readonly [string, string])[] = [
    ["spanDays", "name-collision.stdout.txt"],
    ["nothingHere", "name-empty.stdout.txt"],
  ];
  for (const [what, file] of cases) {
    it(file, async () => {
      expect(await name(repo, what)).toStrictEqual(await golden(file));
    });
  }
});

describe("окно уровня каталога сужает ответ", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("оба тёзки лежат в src", async () => {
    const text = await name(repo, "spanDays", "fixture:src");
    expect(text.includes("объявления: 2"), text).toBe(true);
  });

  it("каталог есть, разбираемых файлов в нём нет", async () => {
    // `docs` на диске есть, но в программу не входит ни один его
    // файл. Это ответ «имя здесь свободно», а не «каталога нет»:
    // существование каталога решает диск, а не состав программы.
    const text = await name(repo, "spanDays", "fixture:docs");
    expect(text.includes("объявления: 0"), text).toBe(true);
  });

  it("каталога нет — ошибка ввода, а не пустой ответ", async () => {
    const err = await name(repo, "spanDays", "fixture:nowhere").catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("каталога 'nowhere' нет в fixture на вне git");
  });

  it("окно, выходящее за корень, — ошибка ввода", async () => {
    // `src/..` — это корень репозитория, а не каталог `src/..`:
    // без нормализации префикс не совпадал ни с чем, и ответом
    // становилось честное на вид «имя свободно» там, где имя занято
    // дважды.
    for (const raw of ["fixture:..", "fixture:src/../.."]) {
      const err = await name(repo, "spanDays", raw).catch((thrown: unknown) =>
        thrown
      );
      assert(err instanceof UsageError);
      expect(err.message).toStrictEqual(
        `каталог окна выходит за корень репозитория: '${raw}'`,
      );
    }
  });

  it("окно, свёрнутое в корень, отвечает как весь репозиторий", async () => {
    const text = await name(repo, "spanDays", "fixture:src/..");
    expect(text.includes("объявления: 2"), text).toBe(true);
  });

  it("неизвестный репозиторий окна", async () => {
    const err = await name(repo, "spanDays", "nope").catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("неизвестный репозиторий 'nope'");
    expect(err.details).toBe("  fixture");
  });
});

describe("строка типов возврата: при двух объявлениях и с пометкой", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("одно объявление — строки нет", async () => {
    const text = await name(repo, "addDays");
    expect(text.includes("объявления: 1"), text).toBe(true);
    expect(text.includes("типы возврата"), text).toBe(false);
  });

  it("два с одним типом — без пометки", async () => {
    const text = await name(repo, "spanDays");
    expect(text.includes("типы возврата: number\n"), text).toBe(true);
    expect(text.includes("различаются"), text).toBe(false);
  });
});

it("тёзки с разными типами возврата помечаются явно", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const root = `${temp}/r`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(
      `${root}/tsconfig.json`,
      '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
    );
    // Два тёзки одного имени с разными типами возврата — случай, ради
    // которого команда и заводится: компилятор о нём не спросит.
    await writeFile(
      `${root}/src/a.ts`,
      "export function span(n: number): number {\n  return n;\n}\n",
    );
    await writeFile(
      `${root}/src/b.ts`,
      "export const span = (n: number): string => String(n);\n",
    );
    const repo: Repo = {
      name: "r",
      root,
      mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
    };
    const text = await name(repo, "span", "r");
    expect(text.includes("типы возврата: number, string — различаются"), text)
      .toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("репозиторий без проектов: объявлений нет — отказ", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const root = `${temp}/plain`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/src/a.ts`, "export const one = 1;\n");
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // `объявления: 0` читалось бы как «имя свободно», а это другой
    // ответ. Печатается он разделом: отказ относится к репозиторию, а
    // не к вызову.
    const result = await runName(
      { name: "one", in: "plain", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    const section = result.sections[0];
    expect(section.kind).toBe("refused");
    if (section.kind !== "refused") return;
    expect(section.refusal).toStrictEqual(
      "объявления не разбираются текстовым анализатором: " +
        "в репозитории plain нет ни одного проекта",
    );
    // Раздел один, и он не ответил — значит не ответил ни один.
    expect(codeNameCommand.textExitCode(result)).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("тёзки, ни один из которых не вызывается", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await plainProject(`${temp}/r`, {
      "src/a.ts": "export const LIMIT = 1;\n",
      "src/b.ts": "export const LIMIT = 2;\n",
    });
    // Объявлений два, вызываемых ноль: вопрос «не разошлись ли
    // возвраты» не возникает, и строки типов возврата быть не должно.
    const text = await name(repo, "LIMIT", "r");
    expect(text.includes("объявления: 2"), text).toBe(true);
    expect(text.includes("типы возврата"), text).toBe(false);
    // Раздела соседей тоже нет: образца сигнатуры взять неоткуда, а
    // «та же сигнатура, другое имя: 0» утверждало бы, что соседей нет.
    expect(text.includes("та же сигнатура"), text).toBe(false);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("один вызываемый тёзка из трёх — строки типов возврата нет", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
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
    expect(text.includes("объявления: 3"), text).toBe(true);
    expect(text.includes("типы возврата"), text).toBe(false);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("пустой репозиторий без проектов — отказ, а не «имя свободно»", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const root = `${temp}/plain`;
    await mkdir(root, { recursive: true });
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // Ни одного файла кода: перечень пуст по обеим причинам сразу, и
    // отказ обязан решаться до сбора файлов, иначе ответом станет
    // «объявления: 0».
    const result = await runName(
      { name: "anything", in: "plain", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(result.sections[0].kind).toBe("refused");
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("два репозитория — два раздела, разделённых пустой строкой", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
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
    expect(result.sections.length, text).toBe(2);
    expect(text.includes("\n\n\n"), JSON.stringify(text)).toBe(false);
    expect(text.endsWith("не разрешено: 0\n"), JSON.stringify(text)).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

/** Репозиторий с tsconfig-проектом из заданных файлов. */
async function plainProject(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Repo> {
  await mkdir(`${root}/src`, { recursive: true });
  await writeFile(
    `${root}/tsconfig.json`,
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  );
  for (const [path, text] of Object.entries(files)) {
    await writeFile(`${root}/${path}`, text);
  }
  const name = root.slice(root.lastIndexOf("/") + 1);
  return {
    name,
    root,
    mark: () => Promise.resolve({ repo: name, state: { kind: "out-of-git" } }),
  };
}

describe("отказ одного репозитория не отменяет ответы остальных", () => {
  let temp: string;
  let broken: Repo;
  let working: Repo;
  let result: {
    name: string;
    sections: ({
      kind: "answer";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      guarantee: "types" | "text";
      declarations: {
        total: number;
        items: {
          path: string;
          line: number;
          name: string;
          signature: string;
          scope:
            | "entry"
            | "module-only"
            | "no-entry"
            | "entry-unparsed"
            | "entry-not-object"
            | "private";
        }[];
      };
      returnTypes: string[];
      neighbours: {
        total: number;
        items: {
          path: string;
          line: number;
          name: string;
          signature: string;
          scope:
            | "entry"
            | "module-only"
            | "no-entry"
            | "entry-unparsed"
            | "entry-not-object"
            | "private";
        }[];
      } | null;
      unresolved: {
        total: number;
        items: {
          path: string;
          line: number;
          specifier: string;
          reason: string;
        }[];
      };
    } | {
      kind: "refused";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      refusal: string;
    })[];
  };
  let text: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    broken = await openBrokenFixture(temp);
    working = await plainProject(`${temp}/works`, {
      "src/a.ts":
        "export function alpha(day: string): string {\n  return day;\n}\n",
    });
    result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => working.root },
      [broken, working],
    );
    text = renderName(result);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("отказавший раздел назвал причину", () => {
    // У отказавшего раздела ни гарантии, ни перечней нет по типу:
    // состояния «отказ и при этом перечень» не существует.
    expect(result.sections[0].kind, text).toBe("refused");
    expect(text.includes("  отказ: конфигурация проекта tsconfig.json"), text)
      .toBe(true);
  });

  it("соседний раздел ответил", () => {
    // Замер спецификатора: один репозиторий без установленных
    // зависимостей обнулял ответ по всем восьми.
    const answered = result.sections[1];
    expect(answered.kind, text).toBe("answer");
    if (answered.kind !== "answer") return;
    expect(answered.declarations.total, text).toBe(1);
  });

  it("ответил хотя бы один — код выхода нулевой", () => {
    expect(codeNameCommand.textExitCode(result), text).toBe(0);
  });
});

it("не ответил ни один раздел — код выхода единица", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const broken = await openBrokenFixture(temp);
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => broken.root },
      [broken],
    );
    // Отказ раздела и отказ команды — разное; совпадают они только
    // когда раздел один (`platform/code-analyzer.md`).
    expect(codeNameCommand.textExitCode(result)).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("репозиторий на чистом JS не обнуляет ответы соседей", () => {
  let temp: string;
  let plain: string;
  let bare: Repo;
  let working: Repo;
  let result: {
    name: string;
    sections: ({
      kind: "answer";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      guarantee: "types" | "text";
      declarations: {
        total: number;
        items: {
          path: string;
          line: number;
          name: string;
          signature: string;
          scope:
            | "entry"
            | "module-only"
            | "no-entry"
            | "entry-unparsed"
            | "entry-not-object"
            | "private";
        }[];
      };
      returnTypes: string[];
      neighbours: {
        total: number;
        items: {
          path: string;
          line: number;
          name: string;
          signature: string;
          scope:
            | "entry"
            | "module-only"
            | "no-entry"
            | "entry-unparsed"
            | "entry-not-object"
            | "private";
        }[];
      } | null;
      unresolved: {
        total: number;
        items: {
          path: string;
          line: number;
          specifier: string;
          reason: string;
        }[];
      };
    } | {
      kind: "refused";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      refusal: string;
    })[];
  };
  let text: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    // Проектов нет вовсе — объявлений текстовый разбор не даёт. Прежде
    // это было отказом ВСЕЙ команды, и один такой репозиторий обнулял
    // ответ по остальным семи: та же беда, что у непостроенной
    // программы, только с другой причиной.
    plain = `${temp}/plain`;
    await mkdir(`${plain}/src`, { recursive: true });
    await writeFile(`${plain}/src/a.js`, "export const a = 1;\n");
    bare = {
      name: "plain",
      root: plain,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    working = await plainProject(`${temp}/works`, {
      "src/a.ts":
        "export function alpha(day: string): string {\n  return day;\n}\n",
    });
    result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => working.root },
      [bare, { ...working, name: "works" }],
    );
    text = renderName(result);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("отказ напечатан разделом, с причиной", () => {
    expect(result.sections[0].kind, text).toBe("refused");
    expect(
      text.includes(
        "  отказ: объявления не разбираются текстовым анализатором: " +
          "в репозитории plain нет ни одного проекта",
      ),
      text,
    ).toBe(true);
  });

  it("соседний раздел ответил", () => {
    const answered = result.sections[1];
    expect(answered.kind, text).toBe("answer");
    if (answered.kind !== "answer") return;
    expect(answered.declarations.total, text).toBe(1);
  });

  it("ответил хотя бы один — код выхода нулевой", () => {
    expect(codeNameCommand.textExitCode(result), text).toBe(0);
  });
});

it("ошибка ввода в окне решается раньше отказа раздела", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Репозиторий без проектов: раздел отказал бы. Но каталога окна в
    // нём нет вовсе, а это ошибка ВВОДА — опечатку надо отличать от
    // «репозиторий не может ответить», иначе оператор ищет проекты там,
    // где надо исправить букву.
    const root = `${temp}/plain`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/src/a.js`, "export const a = 1;\n");
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    const err = await runName(
      { name: "alpha", in: "plain:нет-такого", limit: 200 },
      { cwd: () => root },
      [repo],
    ).catch((thrown: unknown) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("каталога 'нет-такого' нет в plain на вне git");
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("окно проверяется и там, где программа не строится", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Разграничивающий случай: отказ здесь не текстовый, а отказ
    // ПОСТРОЕНИЯ, и он приходит из того же вызова, что раздел. Стой
    // проверка каталога внутри сборки раздела, этот вход давал бы exit
    // 1 — «спроси в другом месте» вместо «такого каталога нет».
    const repo = await openBrokenFixture(temp);
    const err = await runName(
      { name: "alpha", in: "broken-fixture:нет-такого", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    ).catch((thrown: unknown) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe(
      "каталога 'нет-такого' нет в broken-fixture на вне git",
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("окно не платит за соседние проекты", () => {
  let temp: string;
  let root: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    // Наблюдаемый след сужения — раздел «не разрешено»: неразрешённая
    // ссылка живёт в СОСЕДНЕМ проекте, и в ответе по окну её быть не
    // должно, потому что программа соседа не строится вовсе. Без этого
    // случая сужение видно только по времени, то есть никак.
    root = `${temp}/two`;
    for (const pkg of ["p1", "p2"]) {
      await mkdir(`${root}/${pkg}/src`, { recursive: true });
      await writeFile(`${root}/${pkg}/tsconfig.json`, config);
    }
    await writeFile(
      `${root}/p1/src/a.ts`,
      "export function alpha(): number {\n  return 1;\n}\n",
    );
    await writeFile(
      `${root}/p2/src/b.ts`,
      "import { gone } from './нет-такого.ts';\n\nexport const b = gone;\n",
    );
    repo = {
      name: "two",
      root,
      mark: () =>
        Promise.resolve({ repo: "two", state: { kind: "out-of-git" } }),
    };
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  const config =
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n';
  const ask = async (where: string | undefined) => {
    const result = await runName(
      { name: "alpha", in: where, limit: 200 },
      { cwd: () => root },
      [repo],
    );
    const section = result.sections[0];
    if (section.kind !== "answer") throw new Error("раздел отказал");
    return section;
  };

  it("без окна отвечают оба проекта", async () => {
    const section = await ask(undefined);
    expect(section.declarations.total).toBe(1);
    expect(section.unresolved.total).toBe(1);
  });

  it("окно без проектов — пустой ответ, а не отказ", async () => {
    // Проекты в репозитории есть, но окна не покрывает ни один и
    // разбираемых файлов в нём нет: спрашивали про каталог, и ответ —
    // «имя свободно», а не «не могу ответить».
    await mkdir(`${root}/docs`, { recursive: true });
    await writeFile(`${root}/docs/x.md`, "текст\n");
    const result = await runName(
      { name: "alpha", in: "two:docs", limit: 200 },
      { cwd: () => root },
      [repo],
    );
    const section = result.sections[0];
    expect(section.kind, JSON.stringify(section)).toBe("answer");
    if (section.kind !== "answer") throw new Error("раздел отказал");
    expect(section.guarantee).toBe("types");
    expect(section.declarations.total).toBe(0);
  });

  it("файл окна виден и через импорт соседа", async () => {
    // Отбор идёт по составу проекта, а домен ответа — замыкание
    // импортов: `shared/util.ts` не назван ни в одном `include`, но
    // попадает в программу `p1` через `import`. Сузить обход по
    // составу и на этом остановиться значило бы ответить «имя
    // свободно» о занятом имени — молча и под полной гарантией.
    await mkdir(`${root}/shared`, { recursive: true });
    await writeFile(
      `${root}/shared/util.ts`,
      "export function beta(): number {\n  return 2;\n}\n",
    );
    await writeFile(
      `${root}/p1/src/uses.ts`,
      "import { beta } from '../../shared/util.ts';\n\n" +
        "export const b = beta();\n",
    );
    const result = await runName(
      { name: "beta", in: "two:shared", limit: 200 },
      { cwd: () => root },
      [repo],
    );
    const section = result.sections[0];
    if (section.kind !== "answer") throw new Error("раздел отказал");
    expect(section.guarantee).toBe("types");
    expect(section.declarations.total).toBe(1);
    expect(section.declarations.items[0].path).toBe("shared/util.ts");
  });

  it("с окном соседний проект не строится", async () => {
    const section = await ask("two:p1");
    // Ответ тот же и гарантия та же: окно покрыто целиком.
    expect(section.guarantee).toBe("types");
    expect(section.declarations.total).toBe(1);
    expect(section.unresolved.total).toBe(0);
  });
});
