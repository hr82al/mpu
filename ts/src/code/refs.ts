/**
 * Ответ команды `mpu code refs` (`specs/code-refs.md`): кто ещё
 * ссылается на символ и кто читает модуль.
 *
 * Результат самодостаточен — в нём лежат и отметка дерева, и гарантия
 * анализатора, и усечение, и раздел «не разрешено». Рендер из него
 * выводится целиком, а структурная форма для агента не теряет ничего,
 * что видит человек.
 */

import { z } from "@zod/zod";
import { UsageError } from "../command/mod.ts";
import type { Analyzer, Declaration, Target } from "./analyzer.ts";
import type { TreeMark } from "./mark.ts";
import { markLabel } from "./mark.ts";
import { type Address } from "./address.ts";
import type { Repo } from "./workspace.ts";

/** Отметка дерева в структурной форме: `git` пусто — дерево вне git. */
const markSchema = z.object({
  repo: z.string(),
  git: z.object({
    branch: z.string(),
    commit: z.string(),
    dirty: z.boolean(),
  }).nullable(),
});

/** Место потребителя: файл и строка, которой он цель получает. */
const placeSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
});

/** Раздел перечня: сколько нашлось всего и что уместилось в предел. */
const sectionSchema = z.object({
  total: z.number().int().nonnegative(),
  places: z.array(placeSchema),
});

const resultSchema = z.object({
  mark: markSchema,
  guarantee: z.enum(["types", "text"]),
  /** Цель вопроса: символ строки либо модуль целиком. */
  target: z.object({
    kind: z.enum(["symbol", "module"]),
    path: z.string(),
    line: z.number().int().positive().nullable(),
  }),
  /** Объявление цели-символа; у цели-модуля пусто. */
  symbol: z.object({
    name: z.string(),
    signature: z.string().nullable(),
    scope: z.enum(["entry", "module-only", "no-entry", "private", "unknown"]),
  }).nullable(),
  consumers: sectionSchema,
  unresolved: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(z.object({
      path: z.string(),
      line: z.number().int().positive(),
      specifier: z.string(),
      reason: z.string(),
    })),
  }),
});

/** Ответ `mpu code refs`. */
export type RefsResult = z.infer<typeof resultSchema>;

export { resultSchema as refsResultSchema };

/**
 * Собирает ответ по адресу. Отказы здесь — ошибки ввода: адрес назвал
 * репозиторий, файл или строку, которых нет, и продолжать не на чем.
 */
export async function collectRefs(
  address: Address,
  limit: number,
  repo: Repo,
  analyzer: Analyzer,
): Promise<RefsResult> {
  const mark = await analyzer.mark();
  if (!analyzer.hasFile(address.path)) {
    throw new UsageError(
      `файла ${address.path} нет в ${repo.name} на ${markLabel(mark)}`,
    );
  }
  const declaration = address.line === undefined
    ? undefined
    : declarationAt(analyzer, address.path, address.line);
  const target: Target = address.line === undefined
    ? { kind: "module", path: address.path }
    : { kind: "symbol", path: address.path, line: address.line };
  const { places, unresolved } = analyzer.consumersOf(target);
  return {
    mark: asMark(mark),
    guarantee: analyzer.guarantee,
    target: {
      kind: target.kind,
      path: address.path,
      line: address.line ?? null,
    },
    symbol: declaration === undefined ? null : {
      name: declaration.name,
      signature: declaration.signature,
      scope: declaration.scope,
    },
    consumers: { total: places.length, places: places.slice(0, limit) },
    unresolved: {
      total: unresolved.length,
      items: unresolved.slice(0, limit).map((item) => ({ ...item })),
    },
  };
}

/**
 * Объявление, начинающееся в строке адреса. Его отсутствие — ошибка
 * ввода с перечнем объявлений файла: без перечня оператору остаётся
 * угадывать строку, а файл он уже назвал верно.
 */
function declarationAt(
  analyzer: Analyzer,
  path: string,
  line: number,
): Declaration {
  const declarations = analyzer.declarationsOf(path);
  const found = declarations.find((entry) => entry.line === line);
  if (found !== undefined) return found;
  throw new UsageError(`в строке ${line} нет объявления`, {
    details: declarations
      .map((entry) => `  ${path}:${entry.line}  ${entry.name}`)
      .join("\n"),
  });
}

/** Отметка в структурной форме результата. */
function asMark(mark: TreeMark): RefsResult["mark"] {
  return {
    repo: mark.repo,
    git: mark.state.kind === "out-of-git" ? null : {
      branch: mark.state.branch,
      commit: mark.state.commit,
      dirty: mark.state.dirty,
    },
  };
}

/** Отметка обратно из структурной формы — её читает рендер. */
export function markOf(result: RefsResult): TreeMark {
  const git = result.mark.git;
  return {
    repo: result.mark.repo,
    state: git === null ? { kind: "out-of-git" } : {
      kind: "git",
      branch: git.branch,
      commit: git.commit,
      dirty: git.dirty,
    },
  };
}
