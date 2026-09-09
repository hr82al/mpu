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
  TRUNCATION_NOTE,
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
  places: z.array(placeSchema).describe(TRUNCATION_NOTE),
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
        "entry-unparsed",
        "entry-not-object",
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
 * Собирает ответ по адресу. Броски здесь — ошибки ввода: адрес назвал
 * репозиторий, файл или строку, которых нет, и продолжать не на чем.
 * Отказ слоя ошибкой ввода не является и возвращается разделом — с
 * отметкой дерева и причиной.
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
  // Отказ ТЕКСТОВОГО слоя печатается разделом, а не броском. Прежде у
  // него не было ни отметки дерева, ни структурного результата — тогда
  // как у отказа ПОСТРОЕНИЯ той же команды есть и то и другое, хотя
  // наблюдаемая беда одна: спросить объявления не у чего. Инвариант
  // слоя требует отметку у каждого раздела, включая отказавший
  // (`platform/code-analyzer.md`).
  const refusal = analyzer.declarationsRefusal();
  // Цель-модуль текстовому разбору доступна: читатели выводятся из
  // текста честно, с пониженной гарантией. Отказ здесь только у цели,
  // которой нужны объявления, — символа в строке.
  if (address.line !== undefined && refusal !== null) {
    return refusedRefs(mark, refusal);
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
  // Незнание сюда не доходит: `collectRefs` отказал бы разделом раньше.
  // Молчать о нём нельзя — иначе объявления потерялись бы без следа.
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
