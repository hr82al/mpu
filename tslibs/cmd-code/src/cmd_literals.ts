/**
 * Команда `mpu code literals` (`specs/code-literals.md`): какие значения
 * данных в файле повторены литералом и какая величина записана в двух
 * формах.
 *
 * Анализатор слоя она не открывает: разбирается синтаксис отдельных
 * файлов, и полнота перечня от проекта не зависит — поэтому в шапке нет
 * поля гарантии (`platform/code-analyzer.md`, «Исключение — `code
 * literals`»).
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { type CommandIo, defineCommand, UsageError } from "@mpu/command";
import { parseAddress } from "./address.ts";
import { asMark, markSchema, TRUNCATION_NOTE, treeMarkOf } from "./answer.ts";
import { type LineFilter, mergeBase, NO_BASE } from "./changed_lines.ts";
import { spawnGit } from "./git.ts";
import { type FileAnswer, readLiterals } from "./literal_reading.ts";
import type { Pair, Repeat, Tally } from "./literals.ts";
import { renderMarkOnly, type RunGit, type TreeMark } from "./mark.ts";
import { resolveRepo } from "./sweep.ts";
import { isMissing } from "./tree.ts";
import type { Repo } from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
export const DEFAULT_LIMIT = 200;

/** Расширения, у которых считаются литералы. */
const SUFFIXES: readonly string[] = [".ts", ".tsx"];

const argsSchema = z.object({
  addresses: z.array(z.string()).default([]),
  base: z.string().optional(),
  limit: z
    .number()
    .int()
    .positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

const repeatSchema = z.object({
  value: z.string(),
  count: z.number().int().positive(),
  lines: z.array(z.number().int().positive()),
});

const pairSchema = z.object({
  first: z.string(),
  second: z.string(),
  lines: z.array(z.number().int().positive()),
});

const fileSchema = z.object({
  path: z.string(),
  repeats: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(repeatSchema).describe(TRUNCATION_NOTE),
  }),
  pairs: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(pairSchema).describe(TRUNCATION_NOTE),
  }),
});

const unparsedSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .describe(TRUNCATION_NOTE),
});

const sectionSchema = z.object({
  mark: markSchema,
  files: z.array(fileSchema),
  unresolved: unparsedSchema,
});

const resultSchema = z.object({ sections: z.array(sectionSchema) });

/** Ответ `mpu code literals`: по разделу на репозиторий. */
export type LiteralsResult = z.infer<typeof resultSchema>;

type Section = z.infer<typeof sectionSchema>;
type FileSection = z.infer<typeof fileSchema>;

export const codeLiteralsCommand = defineCommand({
  path: ["code", "literals"],
  keys: {
    address: {
      input: "addresses",
      why: "вход-список: ключ в единственном числе, повторяется",
    },
  },
  summary: "на приёмке теста: какие данные повторены литералом и в двух формах",
  usage: "mpu code literals address: АДРЕС... [base: REF] [limit: N]",
  help: `Спрашивают на приёмке и рецензии теста: какие значения данных
повторены литералом и какая величина записана в двух формах (правило
«данные теста — именованная константа»). Лучше грепа: отличает данные
от адресов экрана (data-testid, подписи, роли, названия тестов) и
видит одну величину в двух записях — '101' и 101, '2026-09-04' и
'04.09.2026'.

address: — [РЕПОЗИТОРИЙ:]ПУТЬ к файлу .ts или .tsx, без строки;
адресов может быть несколько. Разделы — по одному на репозиторий,
файлы внутри — в порядке путей.

  base: REF   только записи, задевшие строку, изменённую против
              merge-base REF HEAD в рабочем дереве (файл вне базы —
              целиком); запись печатается со всеми вхождениями
  limit: N    предел записей в разделе, не строк (по умолчанию 200)

Разделов у файла два. «повторы» — значение, встреченное больше одного
раза: ЗНАЧЕНИЕ ×K и строки. «две формы» — число и его строка, дата
ГГГГ-ММ-ДД и тот же день ДД.ММ.ГГГГ, даже по одному вхождению. После
файлов — «не разрешено»: файлы с синтаксической ошибкой и её причина.

Литерал данных — строка, строка атрибута JSX, шаблон без подстановок,
число (минус перед ним — часть значения). Не считаются: названия
тестов (первый аргумент describe/it/test и их форм через точку, у
it.each(…) — второго вызова), все аргументы поисков экрана getBy…/
queryBy…/findBy… (кроме дат), спецификаторы модулей, имена свойств и
литеральные типы, значения '', 0, 1, -1. Даты ГГГГ-ММ-ДД и ДД.ММ.ГГГГ
считаются и внутри строки.

Exit: 0 — ответ, включая пустые разделы, файл с синтаксической
ошибкой и усечение; 2 — ошибка ввода (нет адреса, адрес со строкой,
нет файла, не .ts/.tsx, база не разрешается).`,
  examples: [
    "mpu code literals address: sl-front:src/app/checklist/ChecklistClient.spec.tsx",
    "mpu code literals address: sl-front:src/app/checklist/ChecklistClient.spec.tsx base: main",
  ],
  policy: "ro",
  argsSchema,
  forms: { addresses: { positional: "rest" } },
  resultSchema,
  run: (args, io) => runLiterals(args, io),
  render: renderLiterals,
});

/** Подстановки прогона: рабочая область фикстуры и запуск git. */
export interface LiteralsDeps {
  readonly repos?: readonly Repo[];
  readonly runGit?: RunGit;
}

/** Файл адреса в своём репозитории. */
interface Target {
  readonly repo: Repo;
  readonly path: string;
}

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является. Все адреса проверяются до разбора: ошибка ввода не должна
 * оставить половину ответа.
 */
export async function runLiterals(
  args: {
    readonly addresses: readonly string[];
    readonly base?: string;
    readonly limit: number;
  },
  io: Pick<CommandIo, "cwd">,
  { repos, runGit = spawnGit }: LiteralsDeps = {},
): Promise<LiteralsResult> {
  if (args.addresses.length === 0) {
    throw new UsageError(
      "нужен хотя бы один адрес файла: mpu code literals ПУТЬ.spec.tsx",
    );
  }
  const targets = args.addresses.map((raw) => targetOf(raw, io.cwd(), repos));
  const ts = (await import("typescript")).default;
  const sections: Section[] = [];
  for (const [repo, paths] of byRepo(targets)) {
    // Ключ необязателен: его отсутствие становится объектом «все строки
    // изменены» здесь, на входе, и дальше не проверяется.
    const base =
      args.base === undefined
        ? NO_BASE
        : await mergeBase(runGit, repo.root, args.base);
    const answer = new RepoAnswer(args.limit);
    for (const path of paths) {
      const text = readFileSync(`${repo.root}/${path}`, "utf8");
      const lines = await base.linesOf(path);
      readLiterals(ts, path, text).report(answer.file(lines));
    }
    sections.push(answer.section(await repo.mark()));
  }
  return { sections };
}

/**
 * Адрес — файл без строки, `.ts` или `.tsx`, существующий в репозитории.
 * Порядок проверок — от синтаксиса к диску: расширение видно без чтения.
 */
function targetOf(raw: string, cwd: string, repos?: readonly Repo[]): Target {
  const address = parseAddress(raw);
  if (address.line !== undefined) {
    throw new UsageError(
      "адрес — файл без строки: литералы считаются по всему файлу",
    );
  }
  if (!SUFFIXES.some((suffix) => address.path.endsWith(suffix))) {
    throw new UsageError(
      `литералы считаются только в .ts и .tsx: ${address.path}`,
    );
  }
  const repo = resolveRepo(address, cwd, repos);
  if (!isFile(`${repo.root}/${address.path}`)) {
    throw new UsageError(
      `файла ${address.path} нет в репозитории ${repo.name}`,
    );
  }
  return { repo, path: address.path };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (err) {
    // `путь/файл.ts/x.ts` — `ENOTDIR`, и это тот же ответ «файла нет».
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Файлы по репозиториям: репозитории — по имени, файлы — по пути, повтор
 * адреса — один файл (порядок слоя: репозиторий, путь, строка).
 */
function byRepo(
  targets: readonly Target[],
): readonly (readonly [Repo, readonly string[]])[] {
  const grouped = new Map<string, { repo: Repo; paths: Set<string> }>();
  for (const { repo, path } of targets) {
    const entry = grouped.get(repo.name) ?? { repo, paths: new Set() };
    entry.paths.add(path);
    grouped.set(repo.name, entry);
  }
  return [...grouped.values()]
    .sort((a, b) => compare(a.repo.name, b.repo.name))
    .map(({ repo, paths }) => [repo, [...paths].sort(compare)] as const);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ответ одного репозитория: файлы отдают ему свои исходы, а он режет
 * записи фильтром строк файла и пределом.
 */
class RepoAnswer {
  readonly #files: FileSection[] = [];
  readonly #unparsed: { path: string; reason: string }[] = [];

  constructor(private readonly limit: number) {}

  /** Приёмник исхода одного файла с его фильтром строк. */
  file(lines: LineFilter): FileAnswer {
    return {
      parsed: (path, tally) => this.#parsed(path, tally, lines),
      unparsed: (path, reason) => {
        this.#unparsed.push({ path, reason });
      },
    };
  }

  #parsed(path: string, tally: Tally, lines: LineFilter): void {
    // Запись печатается целиком или не печатается: фильтр спрашивают о
    // всех её строках, и вхождения вне изменённых строк в ней остаются.
    const repeats = tally.repeats().filter((r) => lines.touches(r.lines));
    const pairs = tally.pairs().filter((p) => lines.touches(p.lines));
    this.#files.push({
      path,
      repeats: this.#cut(repeats),
      pairs: this.#cut(pairs),
    });
  }

  section(mark: TreeMark): Section {
    return {
      mark: asMark(mark),
      files: [...this.#files],
      unresolved: this.#cut(this.#unparsed),
    };
  }

  #cut<T>(items: readonly T[]): { total: number; items: T[] } {
    return { total: items.length, items: items.slice(0, this.limit) };
  }
}

/**
 * Текст ответа: по разделу на репозиторий, между ними пустая строка.
 * Внутри раздела — шапка без гарантии, файлы, «не разрешено».
 */
export function renderLiterals(result: LiteralsResult): string {
  return `${result.sections.map(renderSection).join("\n\n")}\n`;
}

function renderSection(section: Section): string {
  return [
    renderMarkOnly(treeMarkOf(section.mark)),
    ...section.files.flatMap((file) => [
      file.path,
      ...block("повторы", file.repeats, repeatLine),
      ...block("две формы", file.pairs, pairLine),
    ]),
    ...block(
      "не разрешено",
      section.unresolved,
      (item) => `${item.path}: ${item.reason}`,
    ),
  ].join("\n");
}

/** Раздел: заголовок со счётчиком, записи с отступом, усечение. */
function block<T>(
  title: string,
  part: { readonly total: number; readonly items: readonly T[] },
  line: (item: T) => string,
): readonly string[] {
  const lines = part.items.map((item) => `  ${line(item)}`);
  if (part.items.length < part.total) {
    lines.push(`  усечено: показано ${part.items.length} из ${part.total}`);
  }
  return [`${title}: ${part.total}`, ...lines];
}

function repeatLine(repeat: Repeat): string {
  return `${repeat.value} ×${repeat.count}  строки ${repeat.lines.join(", ")}`;
}

function pairLine(pair: Pair): string {
  return `${pair.first} ↔ ${pair.second}  строки ${pair.lines.join(", ")}`;
}
