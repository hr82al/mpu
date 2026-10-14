/**
 * Прогон команды по файлам адресов — общий у `code literals` и
 * `code shape` (`specs/code-literals.md`, «Решения по отчёту CL1»;
 * `specs/code-shape.md`, «CLI-контракт»): адрес, `--base`, `--limit`,
 * разбор файла и «не разрешено». Что команда меряет в разобранном
 * файле, решает её `Survey`.
 *
 * Анализатор слоя здесь не открывается: разбирается синтаксис отдельных
 * файлов, и полнота перечня от проекта не зависит — поэтому в шапке нет
 * поля гарантии (`platform/code-analyzer.md`, «Исключение — `code
 * literals` и `code shape`»).
 */

import { readFileSync, statSync } from "node:fs";
import type TS from "typescript";
import { z } from "zod";
import { type CommandIo, UsageError } from "@mpu/command";
import { parseAddress } from "./address.ts";
import { asMark, markSchema, TRUNCATION_NOTE } from "./answer.ts";
import { type LineFilter, mergeBase, NO_BASE } from "./changed_lines.ts";
import { spawnGit } from "./git.ts";
import type { RunGit, TreeMark } from "./mark.ts";
import { resolveRepo } from "./sweep.ts";
import { isMissing } from "./tree.ts";
import type { Repo } from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
export const DEFAULT_LIMIT = 200;

/** Расширения файлов, которые разбираются. */
const SUFFIXES: readonly string[] = [".ts", ".tsx"];

/** Ключи команды по файлам: один источник у обеих поверхностей. */
export const surveyArgsSchema = z.object({
  addresses: z.array(z.string()).default([]),
  base: z.string().optional(),
  limit: z
    .number()
    .int()
    .positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

/** Абзац справки об адресе: одинаков у команд по файлам. */
export const ADDRESS_HELP = `address: — [РЕПОЗИТОРИЙ:]ПУТЬ к файлу .ts или .tsx, без строки;
адресов может быть несколько. Разделы — по одному на репозиторий,
файлы внутри — в порядке путей.`;

/** Строка справки о ключе `limit:`; умолчание — из схемы ключей. */
export const LIMIT_HELP = `  limit: N    предел записей в разделе, не строк (по умолчанию ${DEFAULT_LIMIT})`;

/** Абзац справки о кодах выхода: отказы ввода — общего прогона. */
export const EXIT_HELP = `Exit: 0 — ответ, включая пустые разделы, файл с синтаксической
ошибкой и усечение; 2 — ошибка ввода (нет адреса, адрес со строкой,
нет файла, не .ts/.tsx, база не разрешается).`;

/** Разобранные ключи прогона. */
export interface SurveyArgs {
  readonly addresses: readonly string[];
  readonly base?: string;
  readonly limit: number;
}

/** Схема части раздела: полный счёт и записи до предела. */
export function partSchema<T extends z.ZodType>(item: T) {
  return z.object({
    total: z.number().int().nonnegative(),
    items: z.array(item).describe(TRUNCATION_NOTE),
  });
}

/** Часть раздела: полный счёт и записи до предела. */
export interface Part<T> {
  readonly total: number;
  readonly items: T[];
}

/** Файл, который не разобран, и причина. */
export interface Unparsed {
  readonly path: string;
  readonly reason: string;
}

const unparsedSchema = partSchema(
  z.object({ path: z.string(), reason: z.string() }),
);

/** Схема ответа: по разделу на репозиторий, файлы — схемой команды. */
export function surveySchema<F extends z.ZodType>(file: F) {
  return z.object({
    sections: z.array(
      z.object({
        mark: markSchema,
        files: z.array(file),
        unresolved: unparsedSchema,
      }),
    ),
  });
}

/** Раздел одного репозитория: отметка, файлы, «не разрешено». */
export interface SurveySection<F> {
  readonly mark: z.infer<typeof markSchema>;
  readonly files: F[];
  readonly unresolved: Part<Unparsed>;
}

/** Ответ прогона: по разделу на репозиторий. */
export interface SurveyResult<F> {
  readonly sections: SurveySection<F>[];
}

/** Предел `--limit`: режет записи раздела и помнит полный счёт. */
export class Limit {
  constructor(private readonly size: number) {}

  cut<T>(items: readonly T[]): Part<T> {
    return { total: items.length, items: items.slice(0, this.size) };
  }
}

/** Слова команды в отказах ввода. */
export interface Wording {
  /** Вызов-образец в отказе «нет адресов»: `mpu code literals ПУТЬ.spec.tsx`. */
  readonly example: string;
  /** Что команда делает с файлом: «литералы считаются». */
  readonly measured: string;
}

/** Что команда меряет в разобранном файле. */
export interface Survey<F> {
  readonly wording: Wording;
  /**
   * Раздел файла `path` (путь адреса — тот же, что у «не разрешено»):
   * записи, задевшие строки `lines`, каждая часть — до предела. Запись
   * печатается целиком или не печатается.
   */
  measure(
    ts: typeof TS,
    path: string,
    source: TS.SourceFile,
    lines: LineFilter,
    limit: Limit,
  ): F;
}

/** Подстановки прогона: рабочая область фикстуры и запуск git. */
export interface SurveyDeps {
  readonly repos?: readonly Repo[];
  readonly runGit?: RunGit;
}

/** Файл адреса в своём репозитории. */
interface Target {
  readonly repo: Repo;
  readonly path: string;
}

/**
 * Прогон по адресам. Все адреса проверяются до разбора: ошибка ввода не
 * должна оставить половину ответа.
 */
export async function surveyFiles<F>(
  args: SurveyArgs,
  io: Pick<CommandIo, "cwd">,
  survey: Survey<F>,
  { repos, runGit = spawnGit }: SurveyDeps = {},
): Promise<SurveyResult<F>> {
  if (args.addresses.length === 0) {
    throw new UsageError(
      `нужен хотя бы один адрес файла: ${survey.wording.example}`,
    );
  }
  const targets = args.addresses.map((raw) =>
    targetOf(raw, io.cwd(), survey.wording, repos),
  );
  const ts = (await import("typescript")).default;
  const limit = new Limit(args.limit);
  const sections: SurveySection<F>[] = [];
  for (const [repo, paths] of byRepo(targets)) {
    // Ключ необязателен: его отсутствие становится объектом «все строки
    // изменены» здесь, на входе, и дальше не проверяется.
    const base =
      args.base === undefined
        ? NO_BASE
        : await mergeBase(runGit, repo.root, args.base);
    const answer = new RepoAnswer(ts, survey, limit);
    for (const path of paths) {
      const text = readFileSync(`${repo.root}/${path}`, "utf8");
      const lines = await base.linesOf(path);
      parseSource(ts, path, text).report(answer.file(path, lines));
    }
    sections.push(answer.section(await repo.mark()));
  }
  return { sections };
}

/**
 * Адрес — файл без строки, `.ts` или `.tsx`, существующий в репозитории.
 * Порядок проверок — от синтаксиса к диску: расширение видно без чтения.
 */
function targetOf(
  raw: string,
  cwd: string,
  wording: Wording,
  repos?: readonly Repo[],
): Target {
  const address = parseAddress(raw);
  if (address.line !== undefined) {
    throw new UsageError(
      `адрес — файл без строки: ${wording.measured} по всему файлу`,
    );
  }
  if (!SUFFIXES.some((suffix) => address.path.endsWith(suffix))) {
    throw new UsageError(
      `${wording.measured} только в .ts и .tsx: ${address.path}`,
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

/** Куда разбор отдаёт свой исход. */
interface SourceAnswer {
  parsed(source: TS.SourceFile): void;
  unparsed(reason: string): void;
}

/**
 * Ответ одного репозитория: разобранный файл меряет команда, не
 * разобранный становится строкой «не разрешено».
 */
class RepoAnswer<F> {
  readonly #files: F[] = [];
  readonly #unparsed: Unparsed[] = [];

  constructor(
    private readonly ts: typeof TS,
    private readonly survey: Survey<F>,
    private readonly limit: Limit,
  ) {}

  /** Приёмник исхода одного файла с его фильтром строк. */
  file(path: string, lines: LineFilter): SourceAnswer {
    return {
      parsed: (source) => {
        this.#files.push(
          this.survey.measure(this.ts, path, source, lines, this.limit),
        );
      },
      unparsed: (reason) => {
        this.#unparsed.push({ path, reason });
      },
    };
  }

  section(mark: TreeMark): SurveySection<F> {
    return {
      mark: asMark(mark),
      files: [...this.#files],
      unresolved: this.limit.cut(this.#unparsed),
    };
  }
}

/**
 * `setParentNodes` компилятора: правила обоих обходов спрашивают о месте
 * узла в родителе, без ссылок на родителя они молчали бы.
 */
const WITH_PARENTS = true;

/** Исход разбора файла: дерево синтаксиса или причина, почему его нет. */
interface ParsedSource {
  report(answer: SourceAnswer): void;
}

/**
 * Разбирает текст файла. Синтаксическая ошибка — не отказ всего ответа,
 * а строка «не разрешено»: остальные адреса отвечают.
 */
function parseSource(ts: typeof TS, path: string, text: string): ParsedSource {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    WITH_PARENTS,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const errors = syntaxErrors(ts, file);
  if (errors.length > 0) {
    const reason = describeError(ts, file, errors[0]);
    return { report: (answer) => answer.unparsed(reason) };
  }
  return { report: (answer) => answer.parsed(file) };
}

/**
 * Синтаксические ошибки файла. Публичный путь к ним — программа из
 * одного файла: собственный перечень ошибок разбора у `SourceFile`
 * закрыт. Ни библиотек, ни импортов программа не грузит.
 */
function syntaxErrors(
  ts: typeof TS,
  file: TS.SourceFile,
): readonly TS.DiagnosticWithLocation[] {
  // `types: []` — иначе программа обходит `node_modules/@types` на
  // каждый файл, хотя типы разбору синтаксиса не нужны.
  const options: TS.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const program = ts.createProgram([file.fileName], options, host);
  return program.getSyntacticDiagnostics(file);
}

/** Причина разбора: строка первой ошибки и текст компилятора. */
function describeError(
  ts: typeof TS,
  file: TS.SourceFile,
  error: TS.DiagnosticWithLocation,
): string {
  const line = file.getLineAndCharacterOfPosition(error.start).line + 1;
  return `строка ${line}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`;
}
