/**
 * `mpu code twins --base` против сценариев спеки (`specs/code-twins.md`,
 * «Режим по диффу», «Сценарии»).
 *
 * Фикстура — временный git-репозиторий с деревом голденов `twins-*`,
 * закоммиченным как база; правка сценария — в рабочем дереве. Строка
 * отметки дерева в сравнение не идёт: её поля зависят от репозитория.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { codeTwinsCommand, renderTwins, runTwins } from "./cmd_twins.ts";
import { DEFAULT_LIMIT } from "./file_survey.ts";
import { spawnGit } from "./git.ts";
import {
  commitAll,
  git,
  noBase,
  openFixture,
  put,
  TEMP_PREFIX,
  treeOf,
} from "./testing.ts";
import { readRepos, type Repo } from "./workspace.ts";

/** База сценариев — дословно из спеки. */
const BASE = "HEAD";

/** Имя репозитория дерева голденов. */
const REPO = "fixture";

/** Раздел «не разрешено» из строк, без усечения. */
function unresolved(...lines: readonly string[]): string {
  return [`не разрешено: ${lines.length}`, ...lines, ""].join("\n");
}

/** Неразрешённая ссылка дерева голденов. */
const BROKEN = "  src/broken.ts:3 → ./nowhere — модуль не найден";

/** Хвост ответа: «не разрешено» дерева голденов. */
const UNRESOLVED = unresolved(BROKEN);

/** Строка «не разрешено» тронутого файла вне проектов. */
function outsideLine(path: string): string {
  return `  ${path}: файл вне проектов — тела не разбираются`;
}

/** Похожая пара `utcDayList` дерева: `loaderA` и `loaderB`. */
const LOADER_A = "src/loaderA.ts";
const LOADER_B = "src/loaderB.ts";
const UTC_DAY_LIST = "utcDayList";
const SIGNATURE = `${UTC_DAY_LIST} (from: string, to: string): string[]`;
const LITERAL_A = "'accrual window is not a date'";
const LITERAL_B = "'buyout window is not a date'";
/** Литерал `loaderA` после правки сценария 1. */
const LITERAL_DAY = "'accrual window is not a day'";

/** Счёт тронутых тел. */
function touched(all: number, withTwins: number): string {
  return `тронуто тел: ${all}, с близнецами: ${withTwins}`;
}

/** Строка совпадения в разделе: место и имя. */
function twin(path: string, line: number, name: string): string {
  return `  ${path}:${line}  ${name}`;
}

/** Раздел «похоже» с одним телом `loaderB` и разницей с запрошенным. */
function similarB(difference: string): string {
  return [
    "похоже: 1",
    twin(LOADER_B, 2, UTC_DAY_LIST),
    `    разница: ${difference}`,
  ].join("\n");
}

/** Ответ с одним тронутым телом, у которого есть близнецы. */
function oneBlock(query: string, ...sections: readonly string[]): string {
  return [touched(1, 1), query, ...sections, UNRESOLVED].join("\n\n");
}

/** Раздел «побайтово» с одним телом. */
function exactOne(path: string, line: number, name: string): string {
  return ["побайтово: 1", twin(path, line, name)].join("\n");
}

/** Ответ, в котором не тронуто ни одно тело. */
const NOTHING_TOUCHED = `${touched(0, 0)}\n\n${UNRESOLVED}`;

/** Тройка побайтово равных тел дерева: `windowDays` — в этом файле. */
const WINDOW = "src/window.ts";

/** Правка рабочего дерева поверх закоммиченной базы. */
type Edit = (repo: Repo) => Promise<void>;

/**
 * Репозиторий `fixture` в рабочей области: дерево голденов закоммичено,
 * поверх него — правка сценария.
 */
function probe(edit: Edit) {
  return async (workspace: string): Promise<Repo> => {
    const tree = await openFixture(workspace);
    await seed(tree.root);
    await edit(tree);
    return readRepos(workspace, spawnGit)[0];
  };
}

/** Репозиторий git в `root` с первым коммитом всего, что там лежит. */
async function seed(root: string): Promise<void> {
  await git(root, ["init", "--quiet"]);
  await commitAll(root);
}

/** Текст файла дерева. */
async function text(repo: Repo, path: string): Promise<string> {
  return await readFile(`${repo.root}/${path}`, "utf8");
}

/** Заменяет в файле дерева `from` на `to`. */
function replacing(path: string, from: string, to: string): Edit {
  return async (repo) => {
    const before = await text(repo, path);
    expect(before.includes(from), `${path}: нет «${from}»`).toBe(true);
    await writeFile(`${repo.root}/${path}`, before.replace(from, to));
  };
}

/** Кладёт в дерево копию файла `from` под путём `to`. */
function copying(from: string, to: string): Edit {
  return async (repo) => put(repo, to, await text(repo, from));
}

/** Правки по очереди. */
function both(first: Edit, second: Edit): Edit {
  return async (repo) => {
    await first(repo);
    await second(repo);
  };
}

/** Кладёт в дерево файл `path` с текстом `text`. */
function putting(path: string, text: string): Edit {
  return async (repo) => put(repo, path, text);
}

/** Индексирует файл дерева: новый файл, о котором git уже знает. */
function staging(path: string): Edit {
  return async (repo) => git(repo.root, ["add", "--", path]);
}

/** Ключи вызова. */
interface Keys {
  readonly address?: string;
  readonly base?: string;
  readonly in?: string;
  readonly limit?: number;
}

/** Прогон команды; рабочий каталог — `cwd`, по умолчанию корень. */
async function twins(repo: Repo, keys: Keys, cwd = repo.root): Promise<string> {
  const result = await runTwins(
    { limit: DEFAULT_LIMIT, ...keys },
    { cwd: () => cwd },
    [repo],
  );
  return renderTwins(result);
}

/** Ответ без строки отметки и пустой строки за ней. */
function afterMark(answer: string): string {
  return answer.slice(answer.indexOf("\n\n") + 2);
}

/** Каталог рабочей области над репозиторием — вне всех репозиториев. */
function outside(repo: Repo): string {
  return repo.root.slice(0, repo.root.lastIndexOf("/"));
}

/** Ответ сценария 1: правленый `loaderA` и похожий `loaderB`. */
const SCENARIO_1 = oneBlock(
  `${LOADER_A}:2  ${SIGNATURE}`,
  similarB(`комментарий снят; литерал ${LITERAL_DAY} против ${LITERAL_B}`),
);

/** Ответ сценария 2: новый `loaderC` — копия `loaderA`. */
const LOADER_C = "src/loaderC.ts";
const SCENARIO_2 = oneBlock(
  `${LOADER_C}:2  ${SIGNATURE}`,
  exactOne(LOADER_A, 2, UTC_DAY_LIST),
  similarB(`комментарий снят; литерал ${LITERAL_A} против ${LITERAL_B}`),
);

/** Тело, которого нет больше нигде в дереве. */
const UNIQUE = "{\n  return 'единственное';\n}";

/** Файл с телами без операторов (спека, «Доводка CT1b»). */
const EMPTY = "src/empty.ts";
const EMPTY_BODIES = [
  "export class A {",
  "  constructor(",
  "    private x: number,",
  "  ) {}",
  "}",
  "export const f = async () => {};",
  "export function h() { /* нет */ }",
  "",
].join("\n");
/** Строка объявления пустого конструктора и строка внутри него. */
const EMPTY_DECLARED = 2;
const EMPTY_INSIDE = 3;

/** Файл вне всех проектов дерева: `tsconfig.json` берёт только `src/`. */
const OUTSIDE = "scripts/tool.ts";

/** Две новые функции с одинаковым телом (сценарий 4). */
const [ONE, TWO] = ["one", "two"];

/** Блок функции `name` сценария 4: другая — её близнец. */
function copyBlock(name: string, other: string): string {
  return [
    `src/${name}.ts:1  ${name} (): string`,
    exactOne(`src/${other}.ts`, 1, other),
  ].join("\n\n");
}

describe("ответ по диффу", () => {
  const cases: readonly {
    readonly name: string;
    readonly edit: Edit;
    readonly expected: string;
  }[] = [
    {
      name: "сценарий 1: литерал loaderA изменён — похожее loaderB",
      edit: replacing(LOADER_A, LITERAL_A, LITERAL_DAY),
      expected: SCENARIO_1,
    },
    {
      name: "сценарий 2: новый файл с копией loaderA",
      edit: copying(LOADER_A, LOADER_C),
      expected: SCENARIO_2,
    },
    {
      name: "пустые тела рядом с копией loaderA — не в N и не в блоках",
      edit: both(copying(LOADER_A, LOADER_C), putting(EMPTY, EMPTY_BODIES)),
      expected: SCENARIO_2,
    },
    {
      name: "новый .ts вне всех проектов — в «не разрешено», не в N",
      edit: putting(OUTSIDE, `export function g() ${UNIQUE}\n`),
      expected: `${touched(0, 0)}\n\n${unresolved(outsideLine(OUTSIDE), BROKEN)}`,
    },
    {
      name: "правка .d.ts проекта — не «вне проектов»",
      edit: putting("src/types.d.ts", "export type Day = string;\n"),
      expected: NOTHING_TOUCHED,
    },
    {
      name: "удалённый файл — не тронут и не в «не разрешено»",
      edit: async (tree) => rm(`${tree.root}/${LOADER_B}`),
      expected: NOTHING_TOUCHED,
    },
    {
      name: "новый файл в индексе — так же, как неотслеженный",
      edit: both(copying(LOADER_A, LOADER_C), staging(LOADER_C)),
      expected: SCENARIO_2,
    },
    {
      name: "сценарий 3: изменена строка вне всех тел (импорт)",
      edit: replacing(WINDOW, "from './days'", 'from "./days"'),
      expected: NOTHING_TOUCHED,
    },
    {
      name: "переименование функции на строке { — тело не тронуто",
      edit: replacing(LOADER_B, `${UTC_DAY_LIST}(`, "utcDays("),
      expected: NOTHING_TOUCHED,
    },
    {
      name: "переименование файла с нетронутым телом — не тронуто",
      edit: async (tree) => git(tree.root, ["mv", LOADER_B, "src/loaderD.ts"]),
      expected: NOTHING_TOUCHED,
    },
    {
      name: "тело без близнецов не печатается, но учтено в N",
      edit: replacing("src/days.ts", "slice(0, 10)", "slice(0, 7)"),
      expected: `${touched(1, 0)}\n\n${UNRESOLVED}`,
    },
    {
      name: "из тела удалена строка — тронуто",
      edit: replacing(
        LOADER_A,
        "  // Шаг — следующий календарный день, а не «+86400000 мс».\n",
        "",
      ),
      expected: oneBlock(
        `${LOADER_A}:2  ${SIGNATURE}`,
        similarB(`литерал ${LITERAL_A} против ${LITERAL_B}`),
      ),
    },
    {
      name: "сценарий 4: две новые функции-копии — каждая в блоке другой",
      edit: async (tree) => {
        for (const name of [ONE, TWO]) {
          await put(
            tree,
            `src/${name}.ts`,
            `export function ${name}() ${UNIQUE}\n`,
          );
        }
      },
      expected: [
        touched(2, 2),
        copyBlock(ONE, TWO),
        copyBlock(TWO, ONE),
        UNRESOLVED,
      ].join("\n\n"),
    },
  ];
  for (const { name, edit, expected } of cases) {
    describe(name, () => {
      const repo = treeOf(probe(edit));
      it("ответ", async () => {
        expect(afterMark(await twins(repo(), { base: BASE }))).toStrictEqual(
          expected,
        );
      });
    });
  }
});

describe("база старше HEAD: закоммиченная правка — тоже дифф", () => {
  const repo = treeOf(
    probe(
      both(replacing(LOADER_A, LITERAL_A, LITERAL_DAY), async (tree) =>
        commitAll(tree.root),
      ),
    ),
  );

  it("ответ как у сценария 1", async () => {
    expect(afterMark(await twins(repo(), { base: `${BASE}~1` }))).toStrictEqual(
      SCENARIO_1,
    );
  });
});

describe("предел режет раздел блока", () => {
  const repo = treeOf(probe(copying(WINDOW, "src/copy.ts")));

  it("побайтово: 3, показано 1", async () => {
    expect(
      afterMark(await twins(repo(), { base: BASE, limit: 1 })),
    ).toStrictEqual(
      oneBlock(
        "src/copy.ts:4  windowDays (from: string, to: string): string[]",
        [
          "побайтово: 3",
          twin("src/grid.ts", 4, "dayGrid"),
          "  усечено: показано 1 из 3",
        ].join("\n"),
      ),
    );
  });
});

describe("отказы ввода", () => {
  const repo = treeOf(probe(async () => {}));
  const ref = "nowhere";

  const cases: readonly {
    readonly name: string;
    readonly keys: Keys;
    readonly message: string;
  }[] = [
    {
      name: "сценарий 5: --base вместе с адресом",
      keys: { address: `${REPO}:${LOADER_A}:2`, base: BASE },
      message:
        "адрес и --base — разные вопросы: либо одно тело по адресу, либо тела, тронутые диффом",
    },
    {
      name: "--base не разрешается в коммит",
      keys: { base: ref },
      message: noBase(ref),
    },
    {
      name: "--in без --base",
      keys: { address: `${REPO}:${LOADER_A}:2`, in: REPO },
      message: "--in — репозиторий диффа: только вместе с --base",
    },
    {
      name: "ни адреса, ни --base",
      keys: {},
      message: "адрес обязателен: [РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА либо --base REF",
    },
  ];
  for (const { name, keys, message } of cases) {
    it(name, async () => {
      const err = await rejected(() => twins(repo(), keys), UsageError);
      expect(err.message).toStrictEqual(message);
    });
  }

  it("--base без --in вне репозитория — отказ", async () => {
    const err = await rejected(
      () => twins(repo(), { base: BASE }, outside(repo())),
      UsageError,
    );
    expect(err.message).toStrictEqual(
      "--base без --in: каталог вне репозитория рабочей области",
    );
  });

  it("--in называет репозиторий диффа", async () => {
    const answer = await twins(
      repo(),
      { base: BASE, in: REPO },
      outside(repo()),
    );
    expect(afterMark(answer)).toStrictEqual(NOTHING_TOUCHED);
  });
});

describe("адрес на пустое тело", () => {
  const repo = treeOf(probe(putting(EMPTY, EMPTY_BODIES)));

  it("отказ ввода со строкой объявления, ответа нет", async () => {
    const err = await rejected(
      () => twins(repo(), { address: `${REPO}:${EMPTY}:${EMPTY_INSIDE}` }),
      UsageError,
    );
    expect(err.message).toStrictEqual(
      `у объявления в строке ${EMPTY_DECLARED} пустое тело — близнецов не ищем`,
    );
  });
});

describe("несколько функций на одной строке адреса — берётся внешняя", () => {
  const same = "src/same.ts";
  const repo = treeOf(
    probe(
      putting(
        same,
        [
          "export function g(xs: number[]) { return xs.map((x) => { return x * 2; }); }",
          "export function k(p: Promise<void>) { p.catch(() => {}); }",
          "",
        ].join("\n"),
      ),
    ),
  );
  const cases: readonly (readonly [number, string])[] = [
    [1, "g (xs: number[]): number[]"],
    [2, "k (p: Promise<void>): void"],
  ];
  for (const [line, query] of cases) {
    it(`строка ${line}`, async () => {
      const answer = afterMark(
        await twins(repo(), { address: `${REPO}:${same}:${line}` }),
      );
      expect(answer.split("\n")[0]).toStrictEqual(query);
    });
  }
});

describe("предел режет «не разрешено» вместе с файлом вне проектов", () => {
  const repo = treeOf(
    probe(putting(OUTSIDE, `export function g() ${UNIQUE}\n`)),
  );

  it("показано 1 из 2", async () => {
    expect(
      afterMark(await twins(repo(), { base: BASE, limit: 1 })),
    ).toStrictEqual(
      `${touched(0, 0)}\n\nне разрешено: 2\n${outsideLine(OUTSIDE)}\n  усечено: показано 1 из 2\n`,
    );
  });
});

it("база не находится вне git — отказ ввода", async () => {
  const temp = await mkdtemp(TEMP_PREFIX);
  try {
    const repo = await openFixture(temp);
    const err = await rejected(() => twins(repo, { base: BASE }), UsageError);
    expect(err.message).toStrictEqual(noBase(BASE));
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("репозиторий без проектов: тела не разбираются — отказ раздела", async () => {
  const temp = await mkdtemp(TEMP_PREFIX);
  try {
    const root = `${temp}/plain`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(`${root}/src/a.ts`, `export function one() ${UNIQUE}\n`);
    await seed(root);
    const [repo] = readRepos(temp, spawnGit);
    const result = await runTwins(
      { base: BASE, limit: DEFAULT_LIMIT },
      { cwd: () => repo.root },
      [repo],
    );
    expect(result.section.kind, JSON.stringify(result)).toBe("refused");
    expect(codeTwinsCommand.textExitCode(result)).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});
