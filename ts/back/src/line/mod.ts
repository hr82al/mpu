/**
 * Исполнение строки (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком, — если
 * позволяют правила подтверждения (`platform/policy.md`).
 */

import type { CommandIo } from "../command/mod.ts";
import { JSON_FLAG, type Output, runLine } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { type Outcome, runChain } from "../objects/mod.ts";
import {
  type Channel,
  Human,
  NOBODY,
  PolicyError,
  RuleBook,
  type RuleEntry,
} from "../policy/mod.ts";
import type { CliEntry } from "../process/mod.ts";
import { JSON_STRIPPED, NOTHING_STRIPPED, type Stripped } from "./keyed.ts";
import { registrySeeds } from "./seeds.ts";
import { Session } from "./session.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { registryNodes, registryRoot, ruleLinks } from "./tree.ts";

export type { RootMethod } from "./rules.ts";

export { registryNodes, type TreeNode } from "./tree.ts";

/** Действующее решение узла дерева (`specs/web.md`, «Действующие решения»). */
export interface NodeRuling {
  readonly path: readonly string[];
  readonly verdict: string;
  /** Путь правила-победителя; ни одно не совпало — `null`. */
  readonly rule: string | null;
  /** У самого узла есть своё правило. */
  readonly own: boolean;
}

/**
 * Решения для узлов снимка — тем же набором правил, что решает строки:
 * путь узла с хвостом — со звеном `<args>`.
 *
 * @throws PolicyError — файл правил нельзя открыть или прочитать
 */
export function policyTree(file: string | undefined): NodeRuling[] {
  using book = RuleBook.open(file, registrySeeds());
  const owned = new Set(book.list().map((rule) => rule.path));
  return registryNodes().map((node) => {
    const { verdict, won } = book.decide(ruleLinks(node)).record();
    const own = owned.has(node.path.length === 0 ? "*" : node.path.join(" "));
    return { path: node.path, verdict, rule: won, own };
  });
}

/** Граница, до которой ищется общий `--json`: первый `--`. */
function jsonEnd(argv: readonly string[]): number {
  const cut = argv.indexOf(GRAMMAR.literal);
  return cut < 0 ? argv.length : cut;
}

/**
 * Слова для обхода цепочки: без `--json` до первого `--` — иначе корень
 * получил бы непонятое сообщение. Исполнение получает исходный argv.
 */
function walkedWords(argv: readonly string[]): string[] {
  const end = jsonEnd(argv);
  return [
    ...argv.slice(0, end).filter((word) => word !== JSON_FLAG),
    ...argv.slice(end),
  ];
}

/**
 * Снятый `--json`: хвостовой команде он достаётся в исходной строке,
 * ключевой — отказ «формат — сообщение результату».
 */
function strippedOf(argv: readonly string[]): Stripped {
  const asked = argv.slice(0, jsonEnd(argv)).includes(JSON_FLAG);
  return asked ? JSON_STRIPPED : NOTHING_STRIPPED;
}

/** Итог цепочки в поток и код (данные границы). */
function printed(outcome: Outcome, output: Output): number {
  if ("error" in outcome) {
    output.stderr(`${outcome.error}\n`);
    return 2;
  }
  if ("exit" in outcome) return outcome.exit;
  if ("object" in outcome) {
    output.stdout(outcome.object);
    return 2;
  }
  output.stdout(textOf(outcome.value));
  return 0;
}

/**
 * Данные итога текстом: справка — строка как есть; ответы `selectors` и
 * `respondsTo:` — JSON (формы их печати спека не задаёт).
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return `${JSON.stringify(value)}\n`;
}

/** Кто спрашивает подтверждение у строки. */
export type ChannelOf = (io: CommandIo, output: Output) => Channel;

/** Чем точка входа отличается от соседей: правила, вопрос, исполнение. */
export interface LinePorts {
  /** Файл правил; каталога состояния нет — `undefined`. */
  readonly file: string | undefined;
  readonly channel: ChannelOf;
  /**
   * Исполнение строки нынешней диспетчеризацией. Разбор, решение правил и
   * вопрос — до него: у сервера строк оно идёт в очереди, и строка,
   * ждущая ответа, других не держит.
   */
  readonly execute: (run: () => Promise<number>) => Promise<number>;
  /** Методы корня, которые даёт дверь строки (у прямого — нет). */
  readonly rootMethods: readonly RootMethod[];
}

/**
 * Файл правил в каталоге состояния (`platform/policy.md`, «Хранение»).
 *
 * @param stateDir каталог состояния; `undefined` — нет HOME
 */
export function policyFile(stateDir: string | undefined): string | undefined {
  return stateDir === undefined ? undefined : `${stateDir}/policy.db`;
}

/**
 * Канал терминала: человек — только когда и stdin, и stderr терминалы;
 * вопрос — в stderr, ответ — строка stdin.
 *
 * @param readLine одна строка ответа из stdin; конец ввода — `undefined`
 */
export function terminalChannel(
  readLine: () => Promise<string | undefined>,
): ChannelOf {
  return (io, output) => {
    if (!io.stdinIsTerminal() || !io.stderrIsTerminal()) return NOBODY;
    return new Human(output.stderr, readLine);
  };
}

/**
 * Правила файла — те же данные, что у строки `policy`
 * (`platform/policy.md`), с посевом на открытии.
 *
 * @throws PolicyError — файл нельзя открыть или прочитать
 */
export function rulesOf(file: string | undefined): RuleEntry[] {
  using book = RuleBook.open(file, registrySeeds());
  return book.list();
}

/** Прямое исполнение: строка одна, ждать места не у кого. */
export function immediately(run: () => Promise<number>): Promise<number> {
  return run();
}

/**
 * Исполняет строку вызова и возвращает код завершения. Файл правил
 * открывается до разбора строки — нечитаемый файл отказывает любой
 * строке, включая справку.
 *
 * @param ports файл правил, канал вопроса и исполнение
 */
export function lineEntry(ports: LinePorts): CliEntry {
  return async (argv, io, output, journal) => {
    let book: RuleBook;
    try {
      book = RuleBook.open(ports.file, registrySeeds());
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      output.stderr(`${err.message}\n`);
      return 1;
    }
    using _book = book;
    const line = new Session({
      book,
      channel: ports.channel(io, output),
      output,
      dispatch: (view, order) =>
        ports.execute(() =>
          runLine(order.argv(view.executed(argv)), io, output, journal)
        ),
    });
    const root = registryRoot(
      line,
      book,
      ports.rootMethods.map(rootMethod),
      strippedOf(argv),
    );
    const outcome = await runChain(walkedWords(argv), root);
    return printed(outcome, output);
  };
}
