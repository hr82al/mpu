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
import { markLabel } from "./mark.ts";
import { openRepoAnalyzer } from "./open.ts";
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
  scope: z.enum(["entry", "module-only", "no-entry", "private"]),
});

/** Раздел одного репозитория: своя отметка, свой перечень, свой хвост. */
const sectionSchema = z.object({
  mark: markSchema,
  guarantee: z.enum(["types", "text"]),
  declarations: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(declarationSchema),
  }),
  /**
   * Уникальные типы возврата по порядку появления. Пусто — вызываемых
   * объявлений меньше двух, и сравнивать нечего.
   */
  returnTypes: z.array(z.string()),
  unresolved: unresolvedSchema,
});

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
  const sections: z.infer<typeof sectionSchema>[] = [];
  for (const repo of repos) {
    sections.push(
      await sectionOf(
        name,
        window.dir,
        limit,
        repo,
        await openRepoAnalyzer(repo),
      ),
    );
  }
  return { name, sections };
}

/** Раздел одного репозитория. */
async function sectionOf(
  name: string,
  dir: string | undefined,
  limit: number,
  repo: Repo,
  analyzer: Analyzer,
): Promise<z.infer<typeof sectionSchema>> {
  const mark = await analyzer.mark();
  // Отказ решается ДО сбора файлов: иначе пустой репозиторий без
  // проектов ответил бы «объявления: 0», то есть «имя свободно», а это
  // другой ответ (`platform/code-analyzer.md`).
  const refusal = analyzer.declarationsRefusal();
  if (refusal !== null) throw new DomainError(refusal);
  const files = filesIn(analyzer, dir, repo, mark);
  const found = files.flatMap((path) => declarationsOf(analyzer, path, name));
  return {
    mark: asMark(mark),
    guarantee: analyzer.guarantee,
    declarations: {
      total: found.length,
      items: found.slice(0, limit).map(withoutReturnType),
    },
    returnTypes: uniqueReturnTypes(found),
    unresolved: unresolvedOf(analyzer, limit),
  };
}

/**
 * Файлы окна: весь репозиторий либо каталог в нём. Существование
 * каталога решает диск, а не состав программы: каталог без единого
 * разбираемого файла существует, и ответ по нему — «имя свободно», а не
 * «такого каталога нет».
 */
function filesIn(
  analyzer: Analyzer,
  dir: string | undefined,
  repo: Repo,
  mark: Awaited<ReturnType<Analyzer["mark"]>>,
): readonly string[] {
  const all = analyzer.files();
  if (dir === undefined) return all;
  if (!isDirectory(`${repo.root}/${dir}`)) {
    throw new UsageError(
      `каталога '${dir}' нет в ${repo.name} на ${markLabel(mark)}`,
    );
  }
  return all.filter((path) => path.startsWith(`${dir}/`));
}

/** Есть ли такой каталог на диске. */
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Найденное объявление вместе с типом возврата — он нужен хвосту. */
interface Found extends z.infer<typeof declarationSchema> {
  readonly returnType: string | null;
}

/** Объявления файла с этим именем; незнание — отказ, а не пустота. */
function declarationsOf(
  analyzer: Analyzer,
  path: string,
  name: string,
): readonly Found[] {
  const answer = analyzer.declarationsOf(path);
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
    }));
}

/** Тип возврата в ответ не идёт: его место — строка хвоста. */
function withoutReturnType(found: Found): z.infer<typeof declarationSchema> {
  const { returnType: _returnType, ...rest } = found;
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
