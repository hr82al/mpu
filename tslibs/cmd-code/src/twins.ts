/**
 * Ответ команды `mpu code twins` (`specs/code-twins.md`): есть ли у
 * этого тела близнец в другом файле.
 *
 * Два разных вопроса — потому два раздела, которые не смешиваются:
 * побайтовое равенство тела и равенство после нормализации. Тело,
 * попавшее в первый, во втором не повторяется: иначе одно совпадение
 * читалось бы как два.
 */

import { z } from "zod";
import { DomainError, UsageError } from "@mpu/command";
import type { Analyzer } from "./analyzer.ts";
import type { Body } from "./body.ts";
import { difference } from "./body.ts";
import { markLabel, type TreeMark } from "./mark.ts";
import {
  asMark,
  markSchema,
  TRUNCATION_NOTE,
  unresolvedOf,
  unresolvedSchema,
} from "./answer.ts";
import { byPathAndLine } from "./analyzer.ts";
import type { RepoChanges } from "./changed_lines.ts";
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
  twins: z.array(twinSchema).describe(TRUNCATION_NOTE),
});

/** Объявление, чьё тело взято. */
const querySchema = z.object({
  name: z.string(),
  signature: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
});

/**
 * Ответ поверхности: по адресу, по диффу либо отказ. Размеченное
 * объединение по той же причине, что у остальных поверхностей семейства:
 * у отказавшего раздела нет ни гарантии, ни перечней, и состояния «отказ
 * и при этом перечень» существовать не должно.
 */
const answerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    mark: markSchema,
    guarantee: z.enum(["types", "text"]),
    query: querySchema,
    exact: sectionSchema,
    similar: sectionSchema,
    unresolved: unresolvedSchema,
  }),
  z.object({
    kind: z.literal("diff"),
    mark: markSchema,
    guarantee: z.enum(["types", "text"]),
    /** Сколько тел тронуто диффом — с близнецами и без. */
    touched: z.number().int().nonnegative(),
    blocks: z
      .array(
        z.object({
          query: querySchema,
          exact: sectionSchema,
          similar: sectionSchema,
        }),
      )
      .describe(
        "только тронутые тела с близнецами, по (путь, строка); само тело в своих разделах не повторяется",
      ),
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

/** Поля ответа, общие у обоих источников тел запроса. */
type Common = "mark" | "guarantee" | "unresolved";

/** Ответивший раздел по адресу. */
type AddressSection = Extract<TwinsResult["section"], { kind: "answer" }>;

/** Ответивший раздел по диффу. */
type DiffSection = Extract<TwinsResult["section"], { kind: "diff" }>;

/** Часть ответа, которую даёт источник тел запроса. */
export type AnswerPart =
  | Omit<AddressSection, Common>
  | Omit<DiffSection, Common>;

/**
 * Источник тел запроса глазами сборки ответа: что проверить до разбора
 * тел и что ответить по ним.
 */
export interface Asking {
  /** Ошибки ввода, которые видны по анализатору до разбора тел. */
  check(analyzer: Analyzer, mark: TreeMark): void;
  /** Своя часть ответа по телам репозитория. */
  part(
    bodies: readonly Body[],
    analyzer: Analyzer,
    limit: number,
  ): Promise<AnswerPart>;
}

/**
 * Собирает ответ: отметка, гарантия и «не разрешено» — общие у обоих
 * источников, найденное — часть источника.
 */
export async function collectTwins(
  asking: Asking,
  analyzer: Analyzer,
  limit: number,
): Promise<TwinsResult> {
  const mark = await analyzer.mark();
  asking.check(analyzer, mark);
  const answer = analyzer.bodiesOf();
  // Незнание — не пустой раздел: «близнецов нет» и «тела здесь не
  // разбираются» суть разные ответы (`platform/code-analyzer.md`). И
  // печатается оно РАЗДЕЛОМ, а не броском: у брошенного отказа нет ни
  // отметки дерева, ни структурного результата, тогда как у отказа
  // построения той же команды есть и то и другое.
  if (answer.kind === "unknown") return refusedTwins(mark, answer.reason);
  return {
    section: {
      ...(await asking.part(answer.bodies, analyzer, limit)),
      mark: asMark(mark),
      guarantee: analyzer.guarantee,
      unresolved: unresolvedOf(analyzer, limit),
    },
  };
}

/** Файла адреса нет в дереве анализатора — ошибка ввода. */
export function checkFile(
  path: string,
  repo: Repo,
  analyzer: Analyzer,
  mark: TreeMark,
): void {
  if (analyzer.hasFile(path)) return;
  throw new UsageError(
    `файла ${path} нет в ${repo.name} на ${markLabel(mark)}`,
  );
}

/**
 * Часть ответа по адресу. Тело берётся у объявления-функции,
 * охватывающего строку адреса; окно поиска — репозиторий адреса.
 */
export function addressPart(
  path: string,
  line: number,
  bodies: readonly Body[],
  analyzer: Analyzer,
  limit: number,
): Omit<AddressSection, Common> {
  const query = queryBody(bodies, path, line, analyzer);
  const twins = new Twins(query, bodies);
  return {
    kind: "answer",
    query: queryOf(query),
    // Запрошенное тело стоит ПЕРВОЙ строкой, вне общего порядка, и
    // усечением не режется: инвариант «раздел содержит запрошенное»,
    // который держится на счётчике, а не на самом разделе, — не
    // инвариант, и при малом пределе запрошенное выпадало из
    // собственного ответа.
    exact: withQuery(query, twins.exact(limit - 1)),
    similar: twins.similar(limit),
  };
}

/**
 * Часть ответа по диффу: тела, тронутые изменением против базы, и
 * близнецы каждого. Тело без близнецов блока не получает и остаётся
 * только в счёте тронутых.
 */
export function diffPart(
  changes: RepoChanges,
  bodies: readonly Body[],
  limit: number,
): Omit<DiffSection, Common> {
  const touched = bodies
    .filter((body) => changes.touches(body.path, body.span))
    .sort(byPathAndLine);
  return {
    kind: "diff",
    touched: touched.length,
    blocks: touched.flatMap((body) => new Twins(body, bodies).blocks(limit)),
  };
}

/** Строка запроса ответа: имя, сигнатура и место тела. */
function queryOf(body: Body): z.infer<typeof querySchema> {
  return {
    name: body.name,
    signature: body.signature,
    path: body.path,
    line: body.line,
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
    .filter((body) => body.line <= line && line <= body.span.end.line)
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
function withQuery(query: Body, rest: TwinsSection): TwinsSection {
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

/** Раздел совпадений: полный счёт и записи до предела. */
type TwinsSection = z.infer<typeof sectionSchema>;

/** Блок тела в ответе по диффу. */
type TwinsBlock = DiffSection["blocks"][number];

/**
 * Тело и его близнецы среди тел репозитория — примитив команды: из него
 * выводятся ответ по адресу и блоки ответа по диффу. Само тело в свои
 * разделы не входит.
 */
export class Twins {
  readonly #exact: readonly Body[];
  readonly #similar: readonly Body[];

  constructor(
    private readonly query: Body,
    bodies: readonly Body[],
  ) {
    const rest = bodies.filter((body) => body !== query);
    this.#exact = rest.filter((body) => body.text === query.text);
    // Тело из «побайтово» в «похоже» не повторяется: нормализация их тоже
    // сближает, и без этого вычитания одно совпадение читалось бы как два.
    this.#similar = rest.filter(
      (body) =>
        body.text !== query.text && body.normalized === query.normalized,
    );
  }

  /**
   * Блоки тела в ответе по диффу: один — строка запроса и оба раздела,
   * если близнец вне себя есть; без близнецов — ни одного.
   */
  blocks(limit: number): readonly TwinsBlock[] {
    if (this.#exact.length + this.#similar.length === 0) return [];
    return [
      {
        query: queryOf(this.query),
        exact: this.exact(limit),
        similar: this.similar(limit),
      },
    ];
  }

  /** Раздел «побайтово» без самого тела, до предела. */
  exact(limit: number): TwinsSection {
    return section(this.#exact, limit, () => null);
  }

  /** Раздел «похоже» с разницей у каждого тела, до предела. */
  similar(limit: number): TwinsSection {
    return section(this.#similar, limit, (body) =>
      difference(this.query, body),
    );
  }
}

/** Раздел с усечением по пределу; описание разницы даёт вызывающий. */
function section(
  bodies: readonly Body[],
  limit: number,
  describe: (body: Body) => string | null,
): TwinsSection {
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
