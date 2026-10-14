/**
 * `mpu code shape` против сценариев спеки (`specs/code-shape.md`,
 * «Сценарии»).
 *
 * Голден сценария 1 сторожит инварианты спеки: пределы включительные
 * (`row` 40 и `step` 3 вне ответа, `grid` 41 и `walk` 4 — в нём),
 * вложенная функция не наследует глубину внешней (`collect`), вызов с
 * одним аргументом и матчер — не флаг, обратный вызов `describe` не
 * меряется. Случаи вне голдена пишутся тестом рядом с деревом.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { DEFAULT_LIMIT } from "./file_survey.ts";
import { renderShape, runShape } from "./cmd_shape.ts";
import { spawnGit } from "./git.ts";
import {
  at,
  commitAll,
  git,
  noBase,
  openShapeFixture,
  put,
  TEMP_PREFIX,
  testdata,
  treeOf,
} from "./testing.ts";
import { readRepos, type Repo } from "./workspace.ts";

/** Файл сценариев от корня дерева. */
const SAMPLE = "src/sample.ts";
/** Адрес сценария 1 — дословно из спеки. */
const SAMPLE_ADDRESS = `fixture:${SAMPLE}`;
/** Нулевые разделы ответа (спека, «Граничные случаи»). */
const NO_LONG = "длинные: 0";
const NO_DEEP = "глубокие: 0";
const NO_FLAGS = "флаги: 0";
const NO_UNPARSED = "не разрешено: 0";
/** Одна глубокая функция — случаи вне голдена. */
const ONE_DEEP = "глубокие: 1";
/** Запись функции `f` глубины 4 на первой строке файла. */
const F_DEPTH_4 = "  1  f  глубина: 4";

/** Прогон команды; рабочий каталог — корень репозитория. */
async function shape(
  repo: Repo,
  addresses: readonly string[],
  options: { readonly base?: string; readonly limit?: number } = {},
): Promise<string> {
  const result = await runShape(
    { addresses, base: options.base, limit: options.limit ?? DEFAULT_LIMIT },
    { cwd: () => repo.root },
    { repos: [repo] },
  );
  return renderShape(result);
}

/** Голден сценария 1 — копия канала. */
async function golden(): Promise<string> {
  return await testdata("shape-file.stdout.txt");
}

/** Строка голдена по номеру (с нуля). */
async function goldenLine(index: number): Promise<string> {
  return (await golden()).split("\n")[index];
}

/** Номера строк голдена: `grid`, `walk` и флаг `render`. */
const GRID = 3;
const WALK = 5;
const RENDER = 8;

describe("shape на дереве-фикстуре", () => {
  const repo = treeOf(openShapeFixture);

  it("сценарий 1: ответ совпадает с голденом спеки", async () => {
    expect(await shape(repo(), [SAMPLE_ADDRESS])).toStrictEqual(await golden());
  });

  it("файл с синтаксической ошибкой — в «не разрешено»", async () => {
    const broken = "src/broken.ts";
    await put(repo(), broken, "const a = (;\n");
    const text = await shape(repo(), [at(repo(), broken), SAMPLE_ADDRESS]);
    const expected = (await golden()).replace(
      `${NO_UNPARSED}\n`,
      `не разрешено: 1\n  ${broken}: строка 1: Expression expected.\n`,
    );
    expect(text).toStrictEqual(expected);
  });

  it("предел режет записи раздела и называет усечение", async () => {
    const text = await shape(repo(), [SAMPLE_ADDRESS], { limit: 1 });
    expect(text).toContain(
      `глубокие: 2\n${await goldenLine(WALK)}\n  усечено: показано 1 из 2\n`,
    );
  });
});

/** Тело глубины 4 в одну строку: четыре вложенных `for`. */
const DEEP_BODY = "{ for (;;) { for (;;) { for (;;) { for (;;) {} } } } }";

describe("форма в коде, которого голден не касается", () => {
  const repo = treeOf(openShapeFixture);

  /** Разделы файла: строки между путём и «не разрешено». */
  async function sections(path: string, text: string): Promise<string[]> {
    await put(repo(), path, text);
    const lines = (await shape(repo(), [at(repo(), path)])).split("\n");
    return lines.slice(lines.indexOf(path) + 1, lines.indexOf(NO_UNPARSED));
  }

  const cases: readonly {
    readonly name: string;
    readonly path: string;
    readonly text: string;
    readonly expected: readonly string[];
  }[] = [
    {
      name: "стрелка-выражение меряется от => до конца выражения",
      path: "a.ts",
      text: `export const f = (\n  xs: number[],\n) =>\n  [\n${"    0,\n".repeat(38)}  ];\n`,
      expected: ["длинные: 1", "  1  f  строк: 41", NO_DEEP, NO_FLAGS],
    },
    {
      name: "имена: конструктор, метод, аксессор, свойство, присваивание",
      path: "b.ts",
      text: [
        "class K {",
        `  constructor() ${DEEP_BODY}`,
        `  m() ${DEEP_BODY}`,
        `  get g() ${DEEP_BODY}`,
        `  p = () => ${DEEP_BODY};`,
        "}",
        `const o = { q: () => ${DEEP_BODY} };`,
        `o.r = function () ${DEEP_BODY};`,
        "",
      ].join("\n"),
      expected: [
        NO_LONG,
        "глубокие: 6",
        "  2  constructor  глубина: 4",
        "  3  m  глубина: 4",
        "  4  g  глубина: 4",
        "  5  p  глубина: 4",
        "  7  q  глубина: 4",
        "  8  r  глубина: 4",
        NO_FLAGS,
      ],
    },
    {
      name: "catch — уровень своего try",
      path: "c.ts",
      text: "function f(x: boolean) {\n  for (;;) {\n    try {\n    } catch {\n      while (x) {\n        if (x) {\n        }\n      }\n    }\n  }\n}\n",
      expected: [NO_LONG, ONE_DEEP, F_DEPTH_4, NO_FLAGS],
    },
    {
      name: "switch, do и for…in — операторы управления",
      path: "g.ts",
      text: "function f(o: object) {\n  for (const k in o) {\n    do {\n      switch (k) {\n        case 'a':\n          if (k) {\n          }\n      }\n    } while (false);\n  }\n}\n",
      expected: [NO_LONG, ONE_DEEP, F_DEPTH_4, NO_FLAGS],
    },
    {
      name: "finally — уровень своего try: глубина 3 вне ответа",
      path: "h.ts",
      text: "function f(x: boolean) {\n  try {\n  } finally {\n    while (x) {\n      if (x) {\n      }\n    }\n  }\n}\n",
      expected: [NO_LONG, NO_DEEP, NO_FLAGS],
    },
    {
      name: "describe.each не меряется, it внутри — меряется",
      path: "d.spec.ts",
      text: `describe.each([1])('n', (v) => {\n  ${DEEP_BODY}\n  it('m', () => ${DEEP_BODY});\n});\n`,
      expected: [NO_LONG, ONE_DEEP, "  3  (анонимная)  глубина: 4", NO_FLAGS],
    },
    {
      name: "флаги: каждый литерал своей записью, new — тоже вызов",
      path: "e.ts",
      text: "f(true, false);\nnew Foo(x, true);\nexpect.soft(a).not.toBe(1, true);\ng(true);\nh(k(x, true), false);\nfoo\n  .bar(x, true);\n",
      expected: [
        NO_LONG,
        NO_DEEP,
        "флаги: 6",
        "  1  f(…)  аргумент: 1",
        "  1  f(…)  аргумент: 2",
        "  2  Foo(…)  аргумент: 2",
        // На одной строке внешний вызов раньше вложенного.
        "  5  h(…)  аргумент: 2",
        "  5  k(…)  аргумент: 2",
        // Цепочка в две строки печатается одной.
        "  6  foo.bar(…)  аргумент: 2",
      ],
    },
  ];
  for (const { name, path, text, expected } of cases) {
    it(name, async () => {
      expect(await sections(path, text)).toStrictEqual(expected);
    });
  }
});

describe("отказы ввода", () => {
  const repo = treeOf(openShapeFixture);
  const readme = "src/readme.md";
  const none = "src/none.ts";

  const cases: readonly {
    readonly name: string;
    readonly addresses: () => readonly string[];
    readonly message: () => string;
  }[] = [
    {
      name: "сценарий 3: адресов нет",
      addresses: () => [],
      message: () => "нужен хотя бы один адрес файла: mpu code shape ПУТЬ.ts",
    },
    {
      name: "сценарий 3: адрес со строкой",
      addresses: () => [`${SAMPLE_ADDRESS}:12`],
      message: () => "адрес — файл без строки: функции меряются по всему файлу",
    },
    {
      name: "не .ts/.tsx",
      addresses: () => [at(repo(), readme)],
      message: () => `функции меряются только в .ts и .tsx: ${readme}`,
    },
    {
      name: "файла нет",
      addresses: () => [at(repo(), none)],
      message: () => `файла ${none} нет в репозитории ${repo().name}`,
    },
  ];
  for (const { name, addresses, message } of cases) {
    it(name, async () => {
      const err = await rejected(() => shape(repo(), addresses()), UsageError);
      expect(err.message).toStrictEqual(message());
    });
  }
});

/** Метка правки строки: дописывается комментарием, синтаксис цел. */
const EDIT = " // правка";

/**
 * Репозиторий `probe` в рабочей области: файл сценариев закоммичен как
 * в канале, в рабочем дереве к строкам `changed` дописан комментарий.
 */
function probe(changed: readonly number[]) {
  return async (workspace: string): Promise<Repo> => {
    const root = `${workspace}/probe`;
    const sample = await testdata(`shape-tree/${SAMPLE}.txt`);
    await mkdir(`${root}/src`, { recursive: true });
    await git(root, ["init", "--quiet"]);
    await writeFile(`${root}/${SAMPLE}`, sample);
    await commitAll(root);
    const edited = sample
      .split("\n")
      .map((text, i) => (changed.includes(i + 1) ? `${text}${EDIT}` : text));
    await writeFile(`${root}/${SAMPLE}`, edited.join("\n"));
    return readRepos(workspace, spawnGit)[0];
  };
}

/** База сценария 2. */
const BASE = "HEAD";

/** Ответ без строки отметки: её поля зависят от репозитория. */
async function body(repo: Repo): Promise<string> {
  const text = await shape(repo, [at(repo, SAMPLE)], { base: BASE });
  return text.slice(text.indexOf("\n") + 1);
}

/** Строки, попадающие в `row` (60), `grid` (20) и вызов `render` (130). */
const IN_ROW = 60;
const IN_GRID = 20;
const IN_RENDER = 130;

describe("сценарий 2: --base оставляет записи с изменённой строкой", () => {
  const row = treeOf(probe([IN_ROW]));
  const touched = treeOf(probe([IN_GRID, IN_RENDER]));

  it("изменена только строка внутри row — разделы пусты", async () => {
    expect(await body(row())).toStrictEqual(
      `${SAMPLE}\n${NO_LONG}\n${NO_DEEP}\n${NO_FLAGS}\n${NO_UNPARSED}\n`,
    );
  });

  it("изменены строки grid и render — только они", async () => {
    expect(await body(touched())).toStrictEqual(
      `${SAMPLE}\nдлинные: 1\n${await goldenLine(GRID)}\n${NO_DEEP}\nфлаги: 1\n${await goldenLine(RENDER)}\n${NO_UNPARSED}\n`,
    );
  });
});

describe("база не находится вне git", () => {
  it("неразрешимая база — отказ ввода", async () => {
    const temp = await mkdtemp(TEMP_PREFIX);
    try {
      const repo = await openShapeFixture(temp);
      const err = await rejected(
        () => shape(repo, [SAMPLE_ADDRESS], { base: BASE }),
        UsageError,
      );
      expect(err.message).toStrictEqual(noBase(BASE));
    } finally {
      await rm(temp, { recursive: true });
    }
  });
});
