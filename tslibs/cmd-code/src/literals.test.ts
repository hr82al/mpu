/**
 * `mpu code literals` против сценариев спеки (`specs/code-literals.md`,
 * «Сценарии»).
 *
 * Голден сценария 1 сторожит сразу четыре инварианта: исключение
 * названий тестов и поисков экрана, дату внутри строки, пару дат и пару
 * число/строка. Файлы сценариев 7 и 8 пишутся тестом рядом с деревом:
 * спека описывает дерево одним файлом.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { DEFAULT_LIMIT, renderLiterals, runLiterals } from "./cmd_literals.ts";
import { spawnGit } from "./git.ts";
import { openDenoFixture, openLiteralsFixture } from "./testing.ts";
import { readRepos, type Repo } from "./workspace.ts";

/** Файл сценариев от корня дерева. */
const SAMPLE = "front/src/sample.spec.tsx";
/** Адрес сценария 1 — дословно из спеки. */
const SAMPLE_ADDRESS = `fixture:${SAMPLE}`;
/** Префикс временных каталогов теста. */
const TEMP_PREFIX = join(tmpdir(), "mpu-");
/** Слово-данные случаев, где значение не важно. */
const WORD = "q";
/** Нулевые разделы ответа (спека, «Граничные случаи»). */
const NO_REPEATS = "повторы: 0";
const NO_PAIRS = "две формы: 0";
const NO_UNPARSED = "не разрешено: 0";

/** Прогон команды; рабочий каталог — корень первого репозитория. */
async function literals(
  repos: Repo | readonly Repo[],
  addresses: readonly string[],
  options: { readonly base?: string; readonly limit?: number } = {},
): Promise<string> {
  const known = [repos].flat();
  const result = await runLiterals(
    { addresses, base: options.base, limit: options.limit ?? DEFAULT_LIMIT },
    { cwd: () => known[0].root },
    { repos: known },
  );
  return renderLiterals(result);
}

/** Адрес файла в репозитории. */
function at(repo: Repo, path: string): string {
  return `${repo.name}:${path}`;
}

/** Файл `testdata/code/` пакета. */
async function testdata(name: string): Promise<string> {
  return await readFile(new URL(`testdata/code/${name}`, import.meta.url), {
    encoding: "utf8",
  });
}

/** Голден сценария 1 — копия канала. */
async function golden(): Promise<string> {
  return await testdata("literals-file.stdout.txt");
}

/** Строка голдена по номеру (с нуля). */
async function goldenLine(index: number): Promise<string> {
  return (await golden()).split("\n")[index];
}

/** Номера строк голдена: первый повтор и пара число/строка. */
const FIRST_REPEAT = 3;
const NUMBER_PAIR = 6;

/** Кладёт файл в дерево репозитория. */
async function put(repo: Repo, path: string, text: string): Promise<void> {
  const target = `${repo.root}/${path}`;
  await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await writeFile(target, text);
}

/**
 * Репозиторий во временном каталоге на время `describe`, с уборкой;
 * `open` раскладывает его в каталоге.
 */
function treeOf(open: (temp: string) => Promise<Repo>): () => Repo {
  let temp = "";
  let repo = (): Repo => {
    throw new Error("дерево теста не открыто");
  };
  beforeAll(async () => {
    temp = await mkdtemp(TEMP_PREFIX);
    const opened = await open(temp);
    repo = () => opened;
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  return () => repo();
}

describe("literals на дереве-фикстуре", () => {
  const repo = treeOf(openLiteralsFixture);

  it("сценарий 1: ответ совпадает с голденом спеки", async () => {
    expect(await literals(repo(), [SAMPLE_ADDRESS])).toStrictEqual(
      await golden(),
    );
  });

  it("повтор адреса — один файл", async () => {
    expect(
      await literals(repo(), [SAMPLE_ADDRESS, SAMPLE_ADDRESS]),
    ).toStrictEqual(await golden());
  });

  it("сценарий 7: файл с синтаксической ошибкой — в «не разрешено»", async () => {
    const broken = "front/src/broken.spec.ts";
    await put(repo(), broken, "const a = (;\n");
    const text = await literals(repo(), [at(repo(), broken), SAMPLE_ADDRESS]);
    // Разделы второго адреса — как в сценарии 1, без изменений; первый —
    // строкой «не разрешено» с причиной разбора.
    const expected = (await golden()).replace(
      `${NO_UNPARSED}\n`,
      `не разрешено: 1\n  ${broken}: строка 1: Expression expected.\n`,
    );
    expect(text).toStrictEqual(expected);
  });

  it("сценарий 8: файл без повторов и пар — нулевые разделы", async () => {
    const plain = "front/src/plain.ts";
    await put(repo(), plain, "export const a = 'x';\nexport const b = 2;\n");
    expect(await literals(repo(), [at(repo(), plain)])).toStrictEqual(
      `${repo().name} · вне git\n${plain}\n${NO_REPEATS}\n${NO_PAIRS}\n${NO_UNPARSED}\n`,
    );
  });

  it("предел режет записи раздела и называет усечение", async () => {
    const text = await literals(repo(), [SAMPLE_ADDRESS], { limit: 1 });
    expect(text).toContain(
      `повторы: 2\n${await goldenLine(FIRST_REPEAT)}\n  усечено: показано 1 из 2\n`,
    );
  });
});

describe("несколько репозиториев", () => {
  it("разделы по имени репозитория, между ними пустая строка", async () => {
    const temp = await mkdtemp(TEMP_PREFIX);
    try {
      const fixture = await openLiteralsFixture(temp);
      const deno = await openDenoFixture(temp);
      const days = "src/days.ts";
      const text = await literals(
        [fixture, deno],
        [SAMPLE_ADDRESS, at(deno, days)],
      );
      const [first, second] = text.split("\n\n");
      expect(first.split("\n").slice(0, 2)).toStrictEqual([
        `${deno.name} · вне git`,
        days,
      ]);
      expect(second).toStrictEqual(await golden());
    } finally {
      await rm(temp, { recursive: true });
    }
  });
});

/** Строки ответа до записей повторов: отметка, путь, заголовок. */
const HEAD = 3;
/** Строки ответа после записей: «две формы», «не разрешено», пусто. */
const TAIL = 3;

describe("литералы в коде, которого голден не касается", () => {
  const repo = treeOf(openLiteralsFixture);

  /** Записи повторов одного файла; пар в этих случаях нет. */
  async function repeats(path: string, text: string): Promise<string[]> {
    await put(repo(), path, text);
    const lines = (await literals(repo(), [at(repo(), path)])).split("\n");
    // Хвост ответа: «две формы», «не разрешено» и пустая строка за
    // последним переводом строки.
    const tail = lines.slice(-TAIL);
    expect(tail[0], `${path}: пары`).toStrictEqual(NO_PAIRS);
    return lines.slice(HEAD, -TAIL);
  }

  /** Случай: текст файла и записи из одного значения `v`. */
  const cases: readonly {
    readonly name: string;
    readonly path: string;
    readonly v: string;
    readonly text: (v: string) => string;
    readonly expected: (v: string) => readonly string[];
  }[] = [
    {
      name: "тело теста — данные: правило названий берёт только имя",
      path: "a.spec.ts",
      v: WORD,
      text: (v) => `it('x', () => {\n  f('${v}');\n  f('${v}');\n});\n`,
      expected: (v) => [`  '${v}' ×2  строки 2, 3`],
    },
    {
      name: "таблица it.each — данные, имя второго вызова — нет",
      path: "b.spec.ts",
      v: WORD,
      text: (v) =>
        `it.each(['${v}', '${v}'])('имя %s', (v) => v);\nit('имя %s', () => 0);\n`,
      expected: (v) => [`  '${v}' ×2  строки 1`],
    },
    {
      name: "числа равны по значению; минус — часть значения",
      path: "c.ts",
      v: "5",
      text: (v) =>
        `f(${v}e3);\nf(${v}000);\nf(-${v}, -${v});\nf(-1, 0, 1, '');\n`,
      expected: (v) => [`  ${v}000 ×2  строки 1, 2`, `  -${v} ×2  строки 3`],
    },
    {
      name: "шаблон без подстановок — строка; модули, ключи и типы — нет",
      path: "d.ts",
      v: "z",
      text: (v) =>
        `import a from 'm';\nconst x: 'm' = '${v}';\nconst y = { 'm': \`${v}\` };\nrequire('m');\n`,
      expected: (v) => [`  '${v}' ×2  строки 2, 3`],
    },
    {
      name: "строка с датой внутри — и строка, и дата",
      path: "e.ts",
      v: "2026-01-02",
      text: (v) => `f('d=${v}');\nf('d=${v}');\n`,
      expected: (v) => [
        `  'd=${v}' ×2  строки 1, 2`,
        `  '${v}' ×2  строки 1, 2`,
      ],
    },
    {
      name: "перевод строки в значении экранируется: запись — одна строка",
      path: "f.ts",
      v: "a\\nb",
      text: (v) => `f('${v}');\nf('${v}');\n`,
      expected: (v) => [`  '${v}' ×2  строки 1, 2`],
    },
  ];
  for (const { name, path, v, text, expected } of cases) {
    it(name, async () => {
      expect(await repeats(path, text(v))).toStrictEqual(expected(v));
    });
  }
});

describe("отказы ввода", () => {
  const repo = treeOf(openLiteralsFixture);
  /** Несуществующие файлы: нет вовсе, путь сквозь файл, каталог. */
  const none = "front/src/none.ts";
  const through = `${SAMPLE}/x.ts`;
  const folder = "front/dir.ts";
  const readme = "front/src/readme.md";

  const cases: readonly {
    readonly name: string;
    readonly addresses: () => readonly string[];
    readonly message: () => string;
  }[] = [
    {
      name: "сценарий 3: адресов нет",
      addresses: () => [],
      message: () =>
        "нужен хотя бы один адрес файла: mpu code literals ПУТЬ.spec.tsx",
    },
    {
      name: "сценарий 4: адрес со строкой",
      addresses: () => [`${SAMPLE_ADDRESS}:12`],
      message: () =>
        "адрес — файл без строки: литералы считаются по всему файлу",
    },
    ...[none, through, folder].map((path) => ({
      name: `файла нет: ${path}`,
      addresses: () => [at(repo(), path)],
      message: () => `файла ${path} нет в репозитории ${repo().name}`,
    })),
    {
      name: "не .ts/.tsx",
      addresses: () => [at(repo(), readme)],
      message: () => `литералы считаются только в .ts и .tsx: ${readme}`,
    },
  ];
  for (const { name, addresses, message } of cases) {
    it(name, async () => {
      await mkdir(`${repo().root}/${folder}`, { recursive: true });
      const err = await rejected(
        () => literals(repo(), addresses()),
        UsageError,
      );
      expect(err.message).toStrictEqual(message());
    });
  }
});

/** Git с identity коммита в аргументах: глобального конфига может не быть. */
async function git(cwd: string, args: readonly string[]): Promise<void> {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const result = await spawnGit([...identity, ...args], cwd);
  expect(result?.code, `git ${args.join(" ")}`).toBe(0);
}

/** Первый коммит всего, что лежит в `root`. */
async function commitAll(root: string): Promise<void> {
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "--message", "seed"]);
}

/**
 * Репозиторий `probe` в рабочей области `workspace`: файл сценариев
 * закоммичен с `sku='100'` на строке 16, в рабочем дереве — `sku='101'`.
 */
async function openProbe(workspace: string): Promise<Repo> {
  const root = `${workspace}/probe`;
  const sample = await testdata(`literals-tree/${SAMPLE}.txt`);
  await mkdir(`${root}/front/src`, { recursive: true });
  await git(root, ["init", "--quiet"]);
  await writeFile(`${root}/${SAMPLE}`, sample.replace("'101'", "'100'"));
  await commitAll(root);
  await writeFile(`${root}/${SAMPLE}`, sample);
  return readRepos(workspace, spawnGit)[0];
}

/** База сценария 2 и ссылка, которой нет. */
const BASE = "HEAD";
const NO_REF = "nowhere";

/** Отказ неразрешимой базы (спека, «Граничные случаи»). */
function noBase(ref: string): string {
  return `базу ${ref} не найти: git merge-base ${ref} HEAD не ответил`;
}

describe("сценарий 2: --base оставляет записи с изменённой строкой", () => {
  const repo = treeOf(openProbe);

  /** Ответ без строки отметки: её поля зависят от репозитория. */
  async function body(addresses: readonly string[]): Promise<string> {
    const text = await literals(repo(), addresses, { base: BASE });
    return text.slice(text.indexOf("\n") + 1);
  }

  it("изменённая строка 16 оставляет пару 101 ↔ '101' целиком", async () => {
    expect(await body([at(repo(), SAMPLE)])).toStrictEqual(
      `${SAMPLE}\n${NO_REPEATS}\nдве формы: 1\n${await goldenLine(NUMBER_PAIR)}\n${NO_UNPARSED}\n`,
    );
  });

  it("файл вне дерева базы изменён целиком", async () => {
    const fresh = "front/src/fresh.ts";
    const value = WORD;
    await writeFile(
      `${repo().root}/${fresh}`,
      `f('${value}');\nf('${value}');\n`,
    );
    expect(await body([at(repo(), fresh)])).toContain(
      `  '${value}' ×2  строки 1, 2`,
    );
  });

  it("неразрешимая база — отказ ввода", async () => {
    const err = await rejected(
      () => literals(repo(), [at(repo(), SAMPLE)], { base: NO_REF }),
      UsageError,
    );
    expect(err.message).toStrictEqual(noBase(NO_REF));
  });
});

describe("база не берётся у объемлющего репозитория", () => {
  it("пустой .git внутри чужого репозитория — отказ, а не база соседа", async () => {
    const workspace = await mkdtemp(TEMP_PREFIX);
    try {
      await git(workspace, ["init", "--quiet"]);
      await mkdir(`${workspace}/inner/front/src`, { recursive: true });
      await writeFile(`${workspace}/inner/${SAMPLE}`, `f('${WORD}');\n`);
      await commitAll(workspace);
      await mkdir(`${workspace}/inner/.git`);
      const [inner] = readRepos(workspace, spawnGit);
      const err = await rejected(
        () => literals(inner, [at(inner, SAMPLE)], { base: BASE }),
        UsageError,
      );
      expect(err.message).toStrictEqual(noBase(BASE));
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});
