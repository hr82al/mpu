/**
 * Ответ команды `mpu code name` (`specs/code-name.md`): не занято ли имя
 * другим смыслом.
 *
 * Вопрос задают перед тем, как внести объявление, и решают его
 * объявления там, куда вносят новое, — поэтому окно бывает уровня
 * каталога, а разделы разных репозиториев не смешиваются даже при
 * совпадении имён.
 */

import { z } from "@zod/zod";
import { DomainError, UsageError } from "../command/mod.ts";
import type { Analyzer } from "./analyzer.ts";
import {
  asMark,
  markSchema,
  unresolvedOf,
  unresolvedSchema,
} from "./answer.ts";
import { markLabel, type TreeMark } from "./mark.ts";
import { openRepoAnalyzer } from "./open.ts";
import { ProjectBuildError } from "./project.ts";
import {
  asRepo,
  jobsOf,
  type NameJob,
  type RepoData,
  sectionsOf,
} from "./sweep.ts";
import type { Repo } from "./workspace.ts";

/** Окно вопроса: репозиторий целиком либо каталог в нём. */
export interface Window {
  readonly repo: string | undefined;
  readonly dir: string | undefined;
}

const declarationSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  name: z.string(),
  signature: z.string(),
  scope: z.enum([
    "entry",
    "module-only",
    "no-entry",
    "entry-unparsed",
    "entry-not-object",
    "private",
  ]),
});

/**
 * Раздел одного репозитория: либо ответ, либо отказ. Размеченное
 * объединение, а не набор полей, каждое из которых может быть пустым:
 * у отказавшего раздела нет ни гарантии, ни перечней, и произведение
 * независимых `null` допускало бы состояния, которых не бывает, — а
 * рендеру пришлось бы замазывать их подстановками, печатающими неправду
 * (`ts/CLAUDE.md`, «Расширение — discriminated union»).
 */
const sectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    mark: markSchema,
    guarantee: z.enum(["types", "text"]),
    declarations: z.object({
      total: z.number().int().nonnegative(),
      items: z.array(declarationSchema),
    }),
    /**
     * Уникальные типы возврата по порядку появления. Пусто —
     * вызываемых объявлений меньше двух, и сравнивать нечего.
     */
    returnTypes: z.array(z.string()),
    /**
     * Объявления окна с тем же списком типов параметров и другим
     * именем. `null` — образца сигнатуры взять неоткуда, и печатать
     * раздел пустым значило бы утверждать, что соседей нет.
     */
    neighbours: z.object({
      total: z.number().int().nonnegative(),
      items: z.array(declarationSchema),
    }).nullable(),
    unresolved: unresolvedSchema,
  }),
  z.object({
    kind: z.literal("refused"),
    mark: markSchema,
    refusal: z.string(),
  }),
]);

const resultSchema = z.object({
  name: z.string(),
  /** По разделу на репозиторий окна; объединённого перечня не бывает. */
  sections: z.array(sectionSchema),
});

/** Ответ `mpu code name`. */
export type NameResult = z.infer<typeof resultSchema>;

export { resultSchema as nameResultSchema };

/**
 * Собирает ответ по имени и окну. Каждый репозиторий отвечает своим
 * разделом: объединять их значило бы утверждать, что имя занято «где-то
 * там», а вносят объявление всегда в конкретное место.
 */
export async function collectName(
  name: string,
  window: Window,
  limit: number,
  repos: readonly Repo[],
): Promise<NameResult> {
  const jobs = await jobsOf(repos, (repo): NameJob => ({
    kind: "name",
    repo,
    name,
    dir: window.dir,
    limit,
  }));
  return { name, sections: await sectionsOf(jobs, nameSection, sectionSchema) };
}

/**
 * Раздел одного репозитория по заданию. Точка входа воркера: заданием,
 * а не замыканием, потому что считается он в другом потоке.
 */
export async function nameSection(
  job: NameJob,
): Promise<z.infer<typeof sectionSchema>> {
  const repo = asRepo(job.repo);
  // Ошибка ввода решается РАНЬШЕ всякого отказа раздела, а значит и до
  // построения программ: опечатку в окне надо отличать от «репозиторий
  // не может ответить». Стой проверка ниже, отказ построения обгонял бы
  // её и `--in репо:нет-такого` давал бы exit 1 вместо 2
  // (`platform/code-analyzer.md`, «Граничные случаи»). Анализатор ей не
  // нужен: каталог решает диск, а отметка уже снята.
  assertWindow(job.dir, repo, job.repo.mark);
  try {
    return await sectionOf(job, await openRepoAnalyzer(repo));
  } catch (err) {
    // Отказ ПОСТРОЕНИЯ печатается вместо перечня в своём разделе:
    // один репозиторий без установленных зависимостей не должен
    // обнулять ответ по остальным (`platform/code-analyzer.md`).
    if (!(err instanceof ProjectBuildError)) throw err;
    return refused(job.repo.mark, err.message);
  }
}

/** Раздел, который не ответил: отметка есть, ответа нет. */
function refused(
  mark: RepoData["mark"],
  reason: string,
): z.infer<typeof sectionSchema> {
  return { kind: "refused", mark: asMark(mark), refusal: reason };
}

/** Раздел одного репозитория. */
async function sectionOf(
  job: NameJob,
  analyzer: Analyzer,
): Promise<z.infer<typeof sectionSchema>> {
  const { name, dir, limit } = job;
  const mark = await analyzer.mark();
  // Отказ решается ДО сбора файлов: иначе пустой репозиторий без
  // проектов ответил бы «объявления: 0», то есть «имя свободно», а это
  // другой ответ. И печатается он РАЗДЕЛОМ, а не броском: репозиторий на
  // чистом JS иначе обнулял бы ответ по всем остальным — та же беда, что
  // у непостроенной программы, только с другой причиной
  // (`platform/code-analyzer.md`, инварианты).
  const refusal = analyzer.declarationsRefusal();
  if (refusal !== null) return refused(mark, refusal);
  const files = filesIn(analyzer, dir);
  const found = files.flatMap((path) => declarationsOf(analyzer, path, name));
  const wanted = found
    .filter((entry) => entry.paramTypes !== null)
    .map((entry) => (entry.paramTypes ?? []).join(", "));
  return {
    kind: "answer",
    mark: asMark(mark),
    guarantee: analyzer.guarantee,
    declarations: {
      total: found.length,
      items: found.slice(0, limit).map(withoutReturnType),
    },
    returnTypes: uniqueReturnTypes(found),
    // Образец сигнатуры берётся у вызываемых тёзок: их нет — сравнивать
    // не с чем, и раздел не печатается вовсе. Считать по числу
    // объявлений было бы не по тому признаку: два тёзки-константы
    // образца не дают.
    neighbours: wanted.length === 0
      ? null
      : neighboursOf(analyzer, files, name, wanted, limit),
    unresolved: unresolvedOf(analyzer, limit),
  };
}

/**
 * Каталог окна существует — иначе ошибка ввода. Существование решает
 * диск, а не состав программы: каталог без единого разбираемого файла
 * существует, и ответ по нему — «имя свободно», а не «такого каталога
 * нет».
 */
function assertWindow(
  dir: string | undefined,
  repo: Repo,
  mark: TreeMark,
): void {
  if (dir === undefined || isDirectory(`${repo.root}/${dir}`)) return;
  throw new UsageError(
    `каталога '${dir}' нет в ${repo.name} на ${markLabel(mark)}`,
  );
}

/** Файлы окна: весь репозиторий либо каталог в нём. */
function filesIn(
  analyzer: Analyzer,
  dir: string | undefined,
): readonly string[] {
  const all = analyzer.files();
  return dir === undefined
    ? all
    : all.filter((path) => path.startsWith(`${dir}/`));
}

/** Есть ли такой каталог на диске. */
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch (err) {
    // Отсутствие бывает не только `NotFound`: `src/a.ts/x` даёт
    // `NotADirectory`, и это тот же ответ «такого каталога нет».
    if (
      err instanceof Deno.errors.NotFound ||
      err instanceof Deno.errors.NotADirectory
    ) {
      return false;
    }
    throw err;
  }
}

/** Найденное объявление вместе с типом возврата — он нужен хвосту. */
interface Found extends z.infer<typeof declarationSchema> {
  readonly returnType: string | null;
  readonly paramTypes: readonly string[] | null;
}

/** Объявления файла с этим именем; незнание — отказ, а не пустота. */
function declarationsOf(
  analyzer: Analyzer,
  path: string,
  name: string,
): readonly Found[] {
  const answer = analyzer.declarationsOf(path);
  // Незнание сюда не доходит: раздел отказал бы до сбора файлов. Молчать
  // о нём нельзя — иначе файлы потерялись бы без следа.
  if (answer.kind === "unknown") throw new DomainError(answer.reason);
  return answer.declarations
    .filter((entry) => entry.name === name)
    .map((entry) => ({
      path,
      line: entry.line,
      name: entry.name,
      signature: entry.signature,
      scope: entry.scope,
      returnType: entry.returnType,
      paramTypes: entry.paramTypes,
    }));
}

/**
 * Соседи по сигнатуре: объявления окна с тем же списком типов
 * параметров и другим именем. Совпадение считается по параметрам, а не
 * по возврату: живой случай, ради которого раздел заведён, — вносимая
 * функция возвращала `string[]` там, где существующая возвращает
 * `number`, и требуй совпадения возврата, из ответа выпал бы ровно он
 * (`specs/code-name.md`).
 */
function neighboursOf(
  analyzer: Analyzer,
  files: readonly string[],
  name: string,
  wanted: readonly string[],
  limit: number,
): { total: number; items: z.infer<typeof declarationSchema>[] } {
  const items: z.infer<typeof declarationSchema>[] = [];
  for (const path of files) {
    const answer = analyzer.declarationsOf(path);
    // Незнание сюда не доходит: `sectionOf` отказал бы раньше. Молчать
    // о нём здесь нельзя — иначе файлы потерялись бы без следа.
    if (answer.kind === "unknown") throw new DomainError(answer.reason);
    for (const entry of answer.declarations) {
      if (entry.name === name || entry.paramTypes === null) continue;
      if (!wanted.includes(entry.paramTypes.join(", "))) continue;
      items.push({
        path,
        line: entry.line,
        name: entry.name,
        signature: entry.signature,
        scope: entry.scope,
      });
    }
  }
  return { total: items.length, items: items.slice(0, limit) };
}

/** Типы в ответ не идут: их место — строка хвоста и раздел соседей. */
function withoutReturnType(found: Found): z.infer<typeof declarationSchema> {
  const { returnType: _returnType, paramTypes: _paramTypes, ...rest } = found;
  return rest;
}

/**
 * Уникальные типы возврата тёзок по порядку появления — при двух и
 * более ВЫЗЫВАЕМЫХ объявлениях. У двух тёзок-констант возврата нет ни у
 * одного, и вопрос «не разошлись ли возвраты» не возникает; печатать
 * вместо возврата тип самого объявления значило бы переименовать строку
 * молча (`specs/code-name.md`).
 *
 * Считаются по уже собранному перечню, а не вторым обходом: второй
 * обход удваивал бы работу там, где она и так замерена секундами.
 */
function uniqueReturnTypes(found: readonly Found[]): string[] {
  const callable = found.filter(
    (entry): entry is Found & { readonly returnType: string } =>
      entry.returnType !== null,
  );
  if (callable.length < 2) return [];
  const types: string[] = [];
  for (const entry of callable) {
    if (!types.includes(entry.returnType)) types.push(entry.returnType);
  }
  return types;
}
