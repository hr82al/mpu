/**
 * Ответ команды `mpu code twins` (`specs/code-twins.md`): есть ли у
 * этого тела близнец в другом файле.
 *
 * Два разных вопроса — потому два раздела, которые не смешиваются:
 * побайтовое равенство тела и равенство после нормализации. Тело,
 * попавшее в первый, во втором не повторяется: иначе одно совпадение
 * читалось бы как два.
 */

import { z } from "@zod/zod";
import { DomainError, UsageError } from "../command/mod.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Address } from "./address.ts";
import type { Body } from "./body.ts";
import { difference } from "./body.ts";
import { markLabel, type TreeMark } from "./mark.ts";
import {
  asMark,
  markSchema,
  unresolvedOf,
  unresolvedSchema,
} from "./answer.ts";
import { byPathAndLine } from "./analyzer.ts";
import type { Repo } from "./workspace.ts";

/** Совпадение: где лежит тело-близнец и под каким именем. */
const twinSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  name: z.string(),
  /** Чем тело расходится с запрошенным; у побайтового совпадения пусто. */
  difference: z.string().nullable(),
});

/** Раздел совпадений: сколько нашлось и что уместилось в предел. */
const sectionSchema = z.object({
  total: z.number().int().nonnegative(),
  twins: z.array(twinSchema),
});

/**
 * Ответ поверхности: либо ответ, либо отказ. Размеченное объединение по
 * той же причине, что у остальных поверхностей семейства: у отказавшего
 * раздела нет ни гарантии, ни перечней, и состояния «отказ и при этом
 * перечень» существовать не должно.
 */
const answerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    mark: markSchema,
    guarantee: z.enum(["types", "text"]),
    /** Объявление, чьё тело взято. */
    query: z.object({
      name: z.string(),
      signature: z.string(),
      path: z.string(),
      line: z.number().int().positive(),
    }),
    exact: sectionSchema,
    similar: sectionSchema,
    unresolved: unresolvedSchema,
  }),
  z.object({
    kind: z.literal("refused"),
    mark: markSchema,
    refusal: z.string(),
  }),
]);

const resultSchema = z.object({ section: answerSchema });

/** Ответ-отказ: отметка есть, ответа нет. */
export function refusedTwins(mark: TreeMark, reason: string): TwinsResult {
  return {
    section: { kind: "refused", mark: asMark(mark), refusal: reason },
  };
}

/** Ответ `mpu code twins`. */
export type TwinsResult = z.infer<typeof resultSchema>;

export { resultSchema as twinsResultSchema };

/**
 * Собирает ответ по адресу. Тело берётся у объявления-функции,
 * охватывающего строку адреса; окно поиска — репозиторий адреса.
 */
export async function collectTwins(
  address: Address,
  limit: number,
  repo: Repo,
  analyzer: Analyzer,
): Promise<TwinsResult> {
  const mark = await analyzer.mark();
  if (address.line === undefined) {
    throw new UsageError(
      "нужна строка: тело берётся у объявления, охватывающего её",
    );
  }
  if (!analyzer.hasFile(address.path)) {
    throw new UsageError(
      `файла ${address.path} нет в ${repo.name} на ${markLabel(mark)}`,
    );
  }
  const answer = analyzer.bodiesOf();
  // Незнание — не пустой раздел: «близнецов нет» и «тела здесь не
  // разбираются» суть разные ответы (`platform/code-analyzer.md`).
  if (answer.kind === "unknown") throw new DomainError(answer.reason);
  const query = queryBody(answer.bodies, address.path, address.line, analyzer);
  const rest = answer.bodies.filter((body) => body !== query);
  const exact = rest.filter((body) => body.text === query.text);
  // Тело из «побайтово» в «похоже» не повторяется: нормализация их тоже
  // сближает, и без этого вычитания одно совпадение читалось бы как два.
  const similar = rest.filter((body) =>
    body.text !== query.text && body.normalized === query.normalized
  );
  return {
    section: {
      kind: "answer",
      mark: asMark(mark),
      guarantee: analyzer.guarantee,
      query: {
        name: query.name,
        signature: query.signature,
        path: query.path,
        line: query.line,
      },
      // Запрошенное тело стоит ПЕРВОЙ строкой, вне общего порядка, и
      // усечением не режется: инвариант «раздел содержит запрошенное»,
      // который держится на счётчике, а не на самом разделе, — не
      // инвариант, и при малом пределе запрошенное выпадало из
      // собственного ответа.
      exact: withQuery(query, section(exact, limit - 1, () => null)),
      similar: section(similar, limit, (body) => difference(query, body)),
      unresolved: unresolvedOf(analyzer, limit),
    },
  };
}

/**
 * Тело объявления, охватывающего строку адреса. Ошибки ввода здесь две
 * и они разные: строка не покрыта объявлением-функцией вовсе — и
 * покрыта объявлением, у которого тела нет (перегрузка, `declare`).
 */
function queryBody(
  bodies: readonly Body[],
  path: string,
  line: number,
  analyzer: Analyzer,
): Body {
  const inFile = bodies.filter((body) => body.path === path);
  // Охватывающих может быть несколько (стрелка внутри функции); берётся
  // самое внутреннее — то, чьё объявление ближе к строке.
  const covering = inFile
    .filter((body) => body.line <= line && line <= body.endLine)
    .sort((a, b) => b.line - a.line);
  if (covering.length > 0) return covering[0];
  const answer = analyzer.declarationsOf(path);
  if (answer.kind === "unknown") throw new DomainError(answer.reason);
  // Объявление-функция в строке есть, а тела у него нет: перегрузка и
  // `declare` объявляют форму, а не код, и сравнивать у них нечего. Это
  // другой отказ, а не «объявления-функции здесь нет» — но только для
  // функции: строка с `const` или `type` относится ко второй ветке, и
  // перечень объявлений там нужнее.
  const declared = answer.declarations.find((entry) => entry.line === line);
  if (declared !== undefined && isCallable(declared.signature)) {
    throw new UsageError(`у объявления в строке ${line} нет тела`);
  }
  throw new UsageError(`в строке ${line} нет объявления-функции`, {
    details: answer.declarations
      .map((entry) => `  ${path}:${entry.line}  ${entry.name}`)
      .join("\n"),
  });
}

/**
 * Объявляет ли сигнатура вызываемое. Форма вызова начинается скобкой
 * (`(day: string): string`), тип — нет: у `const CONST = 1` сигнатура
 * читается как `1`.
 */
function isCallable(signature: string): boolean {
  return signature.startsWith("(");
}

/** Запрошенное тело первой строкой раздела, поверх усечения остальных. */
function withQuery(
  query: Body,
  rest: z.infer<typeof sectionSchema>,
): z.infer<typeof sectionSchema> {
  return {
    total: rest.total + 1,
    twins: [
      {
        path: query.path,
        line: query.line,
        name: query.name,
        difference: null,
      },
      ...rest.twins,
    ],
  };
}

/** Раздел с усечением по пределу; описание разницы даёт вызывающий. */
function section(
  bodies: readonly Body[],
  limit: number,
  describe: (body: Body) => string | null,
): z.infer<typeof sectionSchema> {
  const sorted = [...bodies].sort(byPathAndLine);
  return {
    total: sorted.length,
    twins: sorted.slice(0, limit).map((body) => ({
      path: body.path,
      line: body.line,
      name: body.name,
      difference: describe(body),
    })),
  };
}
