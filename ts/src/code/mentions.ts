/**
 * Ответ команды `mpu code mentions` (`specs/code-mentions.md`): где путь
 * упомянут в документации и существует ли он в коде.
 *
 * Случай, ради которого команда заводится, — «файл переехал, а адреса в
 * документах остались»: каждое такое упоминание по отдельности выглядит
 * правильным, и находят их только все разом. Поэтому строка
 * существования печатается первой и всегда: без неё перечень упоминаний
 * одинаково выглядит и для живого адреса, и для протухшего.
 */

import { z } from "@zod/zod";
import type { Place } from "./analyzer.ts";
import { byPathAndLine } from "./analyzer.ts";
import { asMark, markSchema, unresolvedSchema } from "./answer.ts";
import { UsageError } from "../command/mod.ts";
import { markLabel } from "./mark.ts";
import type { Repo } from "./workspace.ts";
import { jobsOf, type MentionsJob, sectionsOf } from "./sweep.ts";
import { walkFiles } from "./tree.ts";

/** Расширение документов, которые команда просматривает. */
const DOC_SUFFIXES: readonly string[] = [".md"];

/**
 * Раздел одного репозитория: своя отметка, свой перечень, свой хвост.
 * Размечен `kind`, как и у трёх соседних поверхностей: образцы читает
 * агент как описание тулов, и разметка у трёх из четырёх читалась бы
 * как другой контракт у четвёртой.
 */
const sectionSchema = z.object({
  kind: z.literal("answer"),
  mark: markSchema,
  /** Существует ли путь в коде этого репозитория. */
  exists: z.boolean(),
  mentions: z.object({
    total: z.number().int().nonnegative(),
    places: z.array(z.object({
      path: z.string(),
      line: z.number().int().positive(),
    })),
  }),
  unresolved: unresolvedSchema,
});

const resultSchema = z.object({
  path: z.string(),
  sections: z.array(sectionSchema),
});

/** Ответ `mpu code mentions`. */
export type MentionsResult = z.infer<typeof resultSchema>;

export { resultSchema as mentionsResultSchema };

/**
 * Собирает ответ по пути и окну. Гарантия у этой поверхности всегда
 * пониженная и печатается такой же: команда работает по тексту
 * документов, а не по разбору, и притворяться разбором ей нечем.
 */
export async function collectMentions(
  path: string,
  dir: string | undefined,
  limit: number,
  repos: readonly Repo[],
): Promise<MentionsResult> {
  const jobs = await jobsOf(repos, (repo): MentionsJob => ({
    kind: "mentions",
    repo,
    path,
    dir,
    limit,
  }));
  return {
    path,
    sections: await sectionsOf(jobs, mentionsSection, sectionSchema),
  };
}

/**
 * Раздел одного репозитория по заданию. Точка входа воркера: заданием,
 * а не замыканием, потому что считается он в другом потоке. Ждать этой
 * поверхности нечего — программ она не строит, — и обещать промис ей не
 * из чего.
 */
export function mentionsSection(
  job: MentionsJob,
): z.infer<typeof sectionSchema> {
  const { repo, path, dir, limit } = job;
  // Несуществующий каталог окна — ошибка ввода, а не ноль упоминаний:
  // иначе опечатка в имени неотличима от «упоминаний нет», и это тот
  // самый класс молчания, ради которого семейство и заводится. Та же
  // проверка стоит у `code name`.
  if (dir !== undefined && !isDirectory(`${repo.root}/${dir}`)) {
    throw new UsageError(
      `каталога '${dir}' нет в ${repo.name} на ${markLabel(repo.mark)}`,
    );
  }
  const found = mentionsIn(repo.root, dir, path);
  // Тип раздела назван у функции, а возвращается литерал напрямую:
  // через `Promise.resolve` лишнее поле литерала компилятору не видно
  // вовсе — вывод типа проверки на избыточность не делает (замер
  // разбора диффа). `async` здесь и есть носитель контракта.
  return {
    kind: "answer",
    mark: asMark(repo.mark),
    exists: exists(`${repo.root}/${path}`),
    mentions: { total: found.length, places: found.slice(0, limit) },
    // Анализатора у этой поверхности нет вовсе: она читает текст
    // документов. Разрешать здесь нечего, поэтому и не разрешённого
    // нет — раздел печатается нулевым, как и всякий нулевой.
    unresolved: { total: 0, items: [] },
  };
}

/**
 * Вхождения пути в документы окна. Вхождение — пара «документ, строка»:
 * несколько вхождений в одной строке считаются одним, потому что
 * править их будут вместе, а разные строки — разными правками.
 */
function mentionsIn(
  repoRoot: string,
  dir: string | undefined,
  path: string,
): readonly Place[] {
  // Область просмотра задана спекой: файлы `.md` вне `node_modules`.
  // Общий обход состава проекта здесь не годится — он режет ещё и
  // каталоги с точки, а `.github/CONTRIBUTING.md` документ такой же, и
  // его молчаливая невидимость и есть тот класс дефекта, ради которого
  // команда заводится.
  const docs = walkFiles(repoRoot, DOC_SUFFIXES, () => false, isDependencyDir)
    .filter((doc) => dir === undefined || doc.startsWith(`${dir}/`));
  const found: Place[] = [];
  for (const doc of docs) {
    const text = readText(`${repoRoot}/${doc}`);
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      // Совпадение по подстроке: в тексте адрес обычно обрамлён
      // обратными кавычками, скобками ссылки или знаками препинания.
      if (line.includes(path)) found.push({ path: doc, line: index + 1 });
    });
  }
  return found.sort(byPathAndLine);
}

/** Каталог зависимостей: единственное, что не просматривается. */
function isDependencyDir(name: string): boolean {
  return name === "node_modules";
}

function readText(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** Есть ли такой каталог на диске. */
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Пути нет — в любом из смыслов. `src/days.ts/x` даёт не `NotFound`, а
 * `NotADirectory`: спрашивали про несуществующий путь, и ответ тот же —
 * «в коде нет», а не падение команды.
 */
function isMissing(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound ||
    err instanceof Deno.errors.NotADirectory ||
    err instanceof Deno.errors.IsADirectory;
}
