/**
 * `mpu code copies` против сценариев спеки (`specs/code-copies.md`,
 * «Сценарии»).
 *
 * Голден сценария 1 сторожит поглощение (стрелка внутри `const option`
 * поглощена объявлением), вложенную группу с большим числом вхождений
 * (`JSON.stringify(…)` ×4) и имя параметра (`String(input)`). Сценарий 2
 * — оба порога на шаг в обе стороны, многострочную запись с
 * комментарием и перекрытое имя. Контейнеры тестов голден не ловит: в
 * нём одинаковых `it` два, а порог — три; их сторожит свой случай.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { DEFAULT_LIMIT, renderCopies, runCopies } from "./cmd_copies.ts";
import { spawnGit } from "./git.ts";
import {
  at,
  commitAll,
  git,
  openCopiesFixture,
  put,
  testdata,
  treeOf,
} from "./testing.ts";
import { readRepos, type Repo } from "./workspace.ts";

/** Файлы сценариев от корня дерева. */
const SAMPLE = "front/src/sample.spec.tsx";
const BOUNDS = "front/src/bounds.ts";
/** Адрес сценария 1 — дословно из спеки. */
const SAMPLE_ADDRESS = `fixture:${SAMPLE}`;
/** Нулевые разделы ответа (спека, «Граничные случаи»). */
const NO_COPIES = "копии: 0";
const NO_CONVERSIONS = "преобразования: 0";
const NO_UNPARSED = "не разрешено: 0";

/** Прогон команды; рабочий каталог — корень репозитория. */
async function copies(
  repo: Repo,
  addresses: readonly string[],
  options: { readonly base?: string; readonly limit?: number } = {},
): Promise<string> {
  const result = await runCopies(
    { addresses, base: options.base, limit: options.limit ?? DEFAULT_LIMIT },
    { cwd: () => repo.root },
    { repos: [repo] },
  );
  return renderCopies(result);
}

/** Голден сценария 1 — копия канала. */
async function golden(): Promise<string> {
  return await testdata("copies-file.stdout.txt");
}

/** Строка голдена по номеру (с нуля). */
async function goldenLine(index: number): Promise<string> {
  return (await golden()).split("\n")[index];
}

/** Номера строк голдена: засев, `JSON.stringify(…)`, `String(SELLER)`. */
const SEED = 3;
const STRINGIFY = 4;
const STRING_SELLER = 7;

describe("copies на дереве-фикстуре", () => {
  const repo = treeOf(openCopiesFixture);

  it("сценарий 1: ответ совпадает с голденом спеки", async () => {
    expect(await copies(repo(), [SAMPLE_ADDRESS])).toStrictEqual(
      await golden(),
    );
  });

  it("сценарий 2: пороги, многострочная запись, перекрытое имя", async () => {
    expect(await copies(repo(), [`fixture:${BOUNDS}`])).toStrictEqual(
      [
        "fixture · вне git",
        BOUNDS,
        "копии: 2",
        "  f(1, 2, 3, 4, 5, 6, 7, 8, 9) ×3  строки 3, 4, 5",
        "  m({ seller: 1539401, sku: 101, from: '2026-09-06', to: '202… ×3  строки 11, 12, 18",
        "преобразования: 1",
        "  String(N) ×2  строки 23",
        NO_UNPARSED,
        "",
      ].join("\n"),
    );
  });

  it("сценарий 4: предел режет оба раздела и называет усечение", async () => {
    const text = await copies(repo(), [SAMPLE_ADDRESS], { limit: 1 });
    expect(text).toContain(
      `копии: 3\n${await goldenLine(SEED)}\n  усечено: показано 1 из 3\n`,
    );
    expect(text).toContain(
      `преобразования: 3\n${await goldenLine(STRING_SELLER)}\n  усечено: показано 1 из 3\n`,
    );
  });

  it("сценарий 9: файл с синтаксической ошибкой — в «не разрешено»", async () => {
    const broken = "front/src/broken.ts";
    await put(repo(), broken, "const a = (;\n");
    const text = await copies(repo(), [at(repo(), broken), SAMPLE_ADDRESS]);
    const expected = (await golden()).replace(
      `${NO_UNPARSED}\n`,
      `не разрешено: 1\n  ${broken}: строка 1: Expression expected.\n`,
    );
    expect(text).toStrictEqual(expected);
  });

  it("сценарий 10: файл без копий и преобразований — нулевые разделы", async () => {
    const plain = "front/src/plain.ts";
    await put(repo(), plain, "export const a = 1;\n");
    expect(await copies(repo(), [at(repo(), plain)])).toStrictEqual(
      `fixture · вне git\n${plain}\n${NO_COPIES}\n${NO_CONVERSIONS}\n${NO_UNPARSED}\n`,
    );
  });
});

/** Вызов ровно в 20 лексем (сценарий 2, `f`). */
const CALL = "f(1, 2, 3, 4, 5, 6, 7, 8, 9)";
/** Запись копии `CALL` на строках 1–3. */
const CALL_COPY = `  ${CALL} ×3  строки 1, 2, 3`;
/** Одна запись в «копиях». */
const ONE_COPY = "копии: 1";

/** Вызов из `CALL` и строки, текстом ровно `length` знаков. */
function callOfLength(length: number): string {
  return `f(1, 2, 3, 4, 5, 6, 7, 8, 9, '${"x".repeat(length - 32)}')`;
}

describe("копии и преобразования в коде, которого голден не касается", () => {
  const repo = treeOf(openCopiesFixture);

  /** Разделы файла: строки между путём и «не разрешено». */
  async function sections(path: string, text: string): Promise<string[]> {
    await put(repo(), path, text);
    const lines = (await copies(repo(), [at(repo(), path)])).split("\n");
    return lines.slice(lines.indexOf(path) + 1, lines.indexOf(NO_UNPARSED));
  }

  /** Три одинаковые строки. */
  const thrice = (line: string): string => `${line}\n`.repeat(3);

  const cases: readonly {
    readonly name: string;
    readonly text: string;
    readonly expected: readonly string[];
  }[] = [
    {
      name: "контейнер it и его функция — не фрагменты, тело считается",
      text: thrice(`it('a', () => { ${CALL}; });`),
      expected: [ONE_COPY, CALL_COPY, NO_CONVERSIONS],
    },
    {
      name: "формы через точку и цепочку: describe.skip, it.each(…)(…)",
      text: [
        thrice(`describe.skip('a', function () { ${CALL}; });`),
        thrice(`it.each([1, 2])('a', (n) => { ${CALL}; });`),
        thrice(`test.only('a', () => { ${CALL}; });`),
      ].join(""),
      expected: [
        ONE_COPY,
        `  ${CALL} ×9  строки 1, 2, 3, 4, 5, 6, 7, 8, 9`,
        NO_CONVERSIONS,
      ],
    },
    {
      name: "вызов с корнем не именем — не тест: /x/.test(…)",
      text: thrice(`/x/.test(${CALL});`),
      expected: [
        ONE_COPY,
        `  /x/.test(${CALL}) ×3  строки 1, 2, 3`,
        NO_CONVERSIONS,
      ],
    },
    {
      name: "текст ровно в 60 знаков печатается целиком",
      text: thrice(`${callOfLength(60)};`),
      expected: [
        ONE_COPY,
        `  ${callOfLength(60)} ×3  строки 1, 2, 3`,
        NO_CONVERSIONS,
      ],
    },
    {
      name: "текст в 61 знак — первые 59 и …",
      text: thrice(`${callOfLength(61)};`),
      expected: [
        ONE_COPY,
        `  ${callOfLength(61).slice(0, 59)}… ×3  строки 1, 2, 3`,
        NO_CONVERSIONS,
      ],
    },
    {
      name: "кусок дважды в каждом вхождении копии — своей записью",
      text: thrice(`h(${CALL}, ${CALL});`),
      expected: [
        "копии: 2",
        `  ${`h(${CALL}, ${CALL})`.slice(0, 59)}… ×3  строки 1, 2, 3`,
        `  ${CALL} ×6  строки 1, 2, 3`,
        NO_CONVERSIONS,
      ],
    },
    {
      name: "комментарий JSDoc внутри фрагмента — не лексема",
      text: [
        "m({ a: 1, b: 2, c: 3, d: 4, e: 5 });",
        "m({ a: 1, b: 2, c: 3, d: 4, e: 5 });",
        "m({",
        "  /** @deprecated кабинет */",
        "  a: 1, b: 2, c: 3, d: 4, e: 5 });",
        "",
      ].join("\n"),
      expected: [
        ONE_COPY,
        "  m({ a: 1, b: 2, c: 3, d: 4, e: 5 }) ×3  строки 1, 2, 3",
        NO_CONVERSIONS,
      ],
    },
    {
      name: "лишняя запятая в конце — другая лексема",
      text: `${thrice(`${CALL};`)}${CALL.replace(")", ",)")};\n`,
      expected: [ONE_COPY, CALL_COPY, NO_CONVERSIONS],
    },
    {
      name: "имя из import и деструктуризации — константа файла",
      text: [
        "import { A } from 'a';",
        "const { B } = o;",
        "String(A) + String(A) + Number(B);",
        "Number(B);",
        "",
      ].join("\n"),
      expected: [
        NO_COPIES,
        "преобразования: 2",
        "  String(A) ×2  строки 3",
        "  Number(B) ×2  строки 3, 4",
      ],
    },
    {
      name: "не константа: функция, свойство, литерал, блочное и поднятое имя",
      text: [
        "const N = 1;",
        "function F() {}",
        "String(F) + String(F) + String(o.N) + String(o.N) + String(1) + String(1);",
        "{ const N = 2; String(N) + String(N); }",
        "String(N, N) + String(N, N);",
        "function k() { String(N) + String(N); if (o) { var N = 3; } }",
        "",
      ].join("\n"),
      expected: [NO_COPIES, NO_CONVERSIONS],
    },
  ];
  for (const { name, text, expected } of cases) {
    it(name, async () => {
      expect(await sections("front/src/case.ts", text)).toStrictEqual(expected);
    });
  }
});

/** Адреса отказов: не исходник и файл, которого нет. */
const NOT_SOURCE = "front/package.json";
const NONE = "front/src/none.ts";

describe("отказы ввода", () => {
  const repo = treeOf(openCopiesFixture);

  const cases: readonly {
    readonly name: string;
    readonly addresses: () => readonly string[];
    readonly message: () => string;
  }[] = [
    {
      name: "сценарий 5: адресов нет",
      addresses: () => [],
      message: () =>
        "нужен хотя бы один адрес файла: mpu code copies ПУТЬ.spec.tsx",
    },
    {
      name: "сценарий 6: адрес со строкой",
      addresses: () => [`${SAMPLE_ADDRESS}:12`],
      message: () => "адрес — файл без строки: копии ищутся по всему файлу",
    },
    {
      name: "сценарий 7: не .ts/.tsx",
      addresses: () => [at(repo(), NOT_SOURCE)],
      message: () => `копии ищутся только в .ts и .tsx: ${NOT_SOURCE}`,
    },
    {
      name: "сценарий 8: файла нет",
      addresses: () => [at(repo(), NONE)],
      message: () => `файла ${NONE} нет в репозитории ${repo().name}`,
    },
  ];
  for (const { name, addresses, message } of cases) {
    it(name, async () => {
      const err = await rejected(() => copies(repo(), addresses()), UsageError);
      expect(err.message).toStrictEqual(message());
    });
  }
});

/** Строка сценария 3 с `from: 'day'` — индекс с нуля. */
const LINE_25 = 24;

/**
 * Репозиторий `probe` в рабочей области `workspace`: файл сценариев
 * закоммичен с `from: 'night'` на строке 25, в рабочем дереве — файл
 * фикстуры.
 */
async function openProbe(workspace: string): Promise<Repo> {
  const root = `${workspace}/probe`;
  const sample = await testdata(`copies-tree/${SAMPLE}.txt`);
  const committed = sample.split("\n");
  committed[LINE_25] = committed[LINE_25].replace("'day'", "'night'");
  await mkdir(`${root}/front/src`, { recursive: true });
  await git(root, ["init", "--quiet"]);
  await writeFile(`${root}/${SAMPLE}`, committed.join("\n"));
  await commitAll(root);
  await writeFile(`${root}/${SAMPLE}`, sample);
  return readRepos(workspace, spawnGit)[0];
}

describe("сценарий 3: --base оставляет записи с изменённой строкой", () => {
  const repo = treeOf(openProbe);

  it("изменённая строка 25 оставляет JSON.stringify(…) и String(SELLER) целиком", async () => {
    const text = await copies(repo(), [at(repo(), SAMPLE)], { base: "HEAD" });
    expect(text.slice(text.indexOf("\n") + 1)).toStrictEqual(
      [
        SAMPLE,
        ONE_COPY,
        await goldenLine(STRINGIFY),
        "преобразования: 1",
        await goldenLine(STRING_SELLER),
        NO_UNPARSED,
        "",
      ].join("\n"),
    );
  });
});

/** Строка 15 сценария 2 — внутри многострочного `m({…})` строк 12–17. */
const LINE_15 = 14;

/**
 * Репозиторий `probe`: `bounds.ts` закоммичен с другой датой на строке
 * 15, в рабочем дереве — файл фикстуры.
 */
async function openBoundsProbe(workspace: string): Promise<Repo> {
  const root = `${workspace}/probe`;
  const bounds = await testdata(`copies-tree/${BOUNDS}.txt`);
  const committed = bounds.split("\n");
  committed[LINE_15] = committed[LINE_15].replace("2026-09-06", "2026-09-05");
  await mkdir(`${root}/front/src`, { recursive: true });
  await git(root, ["init", "--quiet"]);
  await writeFile(`${root}/${BOUNDS}`, committed.join("\n"));
  await commitAll(root);
  await writeFile(`${root}/${BOUNDS}`, bounds);
  return readRepos(workspace, spawnGit)[0];
}

describe("--base: изменённая внутренняя строка многострочного вхождения", () => {
  const repo = treeOf(openBoundsProbe);

  it("строка 15 задевает вхождение m({…}) строк 12–17 — копия целиком", async () => {
    const text = await copies(repo(), [at(repo(), BOUNDS)], { base: "HEAD" });
    expect(text.slice(text.indexOf("\n") + 1)).toStrictEqual(
      [
        BOUNDS,
        ONE_COPY,
        "  m({ seller: 1539401, sku: 101, from: '2026-09-06', to: '202… ×3  строки 11, 12, 18",
        NO_CONVERSIONS,
        NO_UNPARSED,
        "",
      ].join("\n"),
    );
  });
});
