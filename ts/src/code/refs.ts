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
import { DomainError, UsageError } from "../command/mod.ts";
import type { Analyzer, Declaration, Target } from "./analyzer.ts";
import { markLabel, type TreeMark } from "./mark.ts";
import {
  asMark,
  markSchema,
  unresolvedOf,
  unresolvedSchema,
} from "./answer.ts";
import { type Address } from "./address.ts";
import type { Repo } from "./workspace.ts";

/** Место потребителя: файл и строка, которой он цель получает. */
const placeSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
});

/** Раздел перечня: сколько нашлось всего и что уместилось в предел. */
const countedSchema = z.object({
  total: z.number().int().nonnegative(),
  places: z.array(placeSchema),
});

/**
 * Ответ поверхности: либо ответ, либо отказ. Размеченное объединение, а
 * не набор независимо пустых полей: у отказавшего раздела нет ни
 * гарантии, ни перечней, и рендеру не приходится замазывать
 * несуществующие состояния подстановками, печатающими неправду
 * (`ts/CLAUDE.md`, «Расширение — discriminated union»).
 */
const sectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
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
      signature: z.string(),
      scope: z.enum([
        "entry",
        "module-only",
        "no-entry",
        "entry-unknown",
        "private",
      ]),
    }).nullable(),
    consumers: countedSchema,
    unresolved: unresolvedSchema,
  }),
  z.object({
    kind: z.literal("refused"),
    mark: markSchema,
    refusal: z.string(),
  }),
]);

const resultSchema = z.object({ section: sectionSchema });

/** Ответ-отказ: отметка есть, ответа нет. */
export function refusedRefs(mark: TreeMark, reason: string): RefsResult {
  return {
    section: { kind: "refused", mark: asMark(mark), refusal: reason },
  };
}

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
  const places = analyzer.consumersOf(target);
  return {
    section: {
      kind: "answer",
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
      unresolved: unresolvedOf(analyzer, limit),
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
  const answer = analyzer.declarationsOf(path);
  // Незнание — не пустой перечень: «в файле нет объявлений» и «объявления
  // здесь не разбираются» суть разные ответы с разными кодами выхода
  // (`platform/code-analyzer.md`).
  if (answer.kind === "unknown") throw new DomainError(answer.reason);
  const declarations = answer.declarations;
  const found = declarations.find((entry) => entry.line === line);
  if (found !== undefined) return found;
  throw new UsageError(`в строке ${line} нет объявления`, {
    details: declarations
      .map((entry) => `  ${path}:${entry.line}  ${entry.name}`)
      .join("\n"),
  });
}
