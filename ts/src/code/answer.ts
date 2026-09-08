/**
 * Общие части ответа семейства `mpu code` (`platform/code-analyzer.md`,
 * «Форма ответа»): отметка дерева в структурной форме и раздел
 * «не разрешено».
 *
 * Одни на все поверхности, потому что это и есть форма ответа слоя, а
 * не совпадение двух команд: разойтись им нельзя — шапка и хвост
 * читаются одинаково у любого вопроса.
 */

import { z } from "@zod/zod";
import type { Analyzer, Scope } from "./analyzer.ts";
import type { TreeMark } from "./mark.ts";

/**
 * Три значения области видимости и четвёртое — у проекта без входа
 * (`platform/code-analyzer.md`). Одна строка, а не два признака, и одна
 * на все поверхности: расходиться двум текстам об одном факте незачем.
 */
const SCOPE_TEXT: Readonly<Record<Scope, string>> = {
  entry: "экспортируется из модуля и из входа проекта",
  "module-only":
    "экспортируется из модуля; из входа проекта не реэкспортируется",
  "no-entry": "экспортируется из модуля; входа у проекта нет",
  "entry-unknown":
    "экспортируется из модуля; вход проекта не определён: манифест не разобран",
  private: "приватное в модуле",
};

/** Строка области видимости объявления. */
export function scopeText(scope: Scope): string {
  return SCOPE_TEXT[scope];
}

/** Отметка дерева в структурной форме: `git` пусто — дерево вне git. */
export const markSchema = z.object({
  repo: z.string(),
  git: z.object({
    branch: z.string(),
    commit: z.string(),
    dirty: z.boolean(),
  }).nullable(),
});

/** Раздел «не разрешено»: печатается всегда, в том числе нулевой. */
export const unresolvedSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    path: z.string(),
    line: z.number().int().positive(),
    specifier: z.string(),
    reason: z.string(),
  })),
});

/** Отметка дерева в структурной форме. */
export function asMark(mark: TreeMark): z.infer<typeof markSchema> {
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
export function treeMarkOf(mark: z.infer<typeof markSchema>): TreeMark {
  return {
    repo: mark.repo,
    state: mark.git === null ? { kind: "out-of-git" } : {
      kind: "git",
      branch: mark.git.branch,
      commit: mark.git.commit,
      dirty: mark.git.dirty,
    },
  };
}

/**
 * Ссылки репозитория, которые разобрать не удалось. Раздел описывает
 * репозиторий, а не запрос, поэтому одинаков у всех поверхностей и
 * спрашивается отдельной операцией.
 */
export function unresolvedOf(
  analyzer: Analyzer,
  limit: number,
): z.infer<typeof unresolvedSchema> {
  const unresolved = analyzer.unresolvedOf();
  return {
    total: unresolved.length,
    items: unresolved.slice(0, limit).map((item) => ({ ...item })),
  };
}
