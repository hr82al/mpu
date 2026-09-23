/**
 * Исполнение строки (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком, — если
 * позволяют правила подтверждения (`platform/policy.md`).
 */

import type { CommandIo } from "../command/mod.ts";
import {
  JSON_FLAG,
  type Output,
  PRINT,
  runLine,
  streams,
} from "../entrypoint/mod.ts";
import type { RefusalData } from "../frames/mod.ts";
import { GRAMMAR, UNNAMED_REFUSAL } from "../messages/mod.ts";
import { plainRefusal, runChain } from "../objects/mod.ts";
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
import { targetValues } from "../selector/mod.ts";
import { itMethod, type Memory, NO_CALLER, remembering } from "./it.ts";
import { printed, type Speech } from "./printed.ts";
import { Session } from "./session.ts";
export { HUMAN_ONLY } from "./session.ts";
import { LineValues, StdinOnce } from "./value.ts";
import { ASK_WORD } from "./view.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { registryNodes, registryRoot, ruleLinks } from "./tree.ts";

export type { RootMethod } from "./rules.ts";
export { LastResults, type Memory, NO_CALLER } from "./it.ts";

export { registryNodes, type TreeNode } from "./tree.ts";
export { selectionMessages } from "../objects/mod.ts";

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
  /** Память вызывающего строки: её результат и ответ на `it`. */
  readonly memory: Memory;
  /**
   * Отказ строки объектом — вызывающему, перед его текстом в stderr
   * (`platform/refusal-object.md`); у прямого вызова объект не нужен.
   */
  readonly refusal: (data: RefusalData) => void;
}

/** Отказ-объект никому не нужен: достаточно текста. */
export const NO_REFUSAL = (_data: RefusalData) => {};

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
    const speech: Speech = {
      stdout: (text) => output.stdout(text),
      stderr: (text) => output.stderr(text),
      refusal: ports.refusal,
    };
    let book: RuleBook;
    try {
      book = RuleBook.open(ports.file, registrySeeds());
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      plainRefusal(UNNAMED_REFUSAL, err.message).tell(speech);
      return 1;
    }
    using _book = book;
    // stdin строки — один источник: ключом `stdin` и прежней подстановкой.
    const stdin = new StdinOnce(io);
    const lineIo: CommandIo = { ...io, readStdin: () => stdin.forCommand() };
    const channel = ports.channel(io, output);
    const parts = {
      own: [
        ...ports.rootMethods.map(rootMethod),
        itMethod(ports.memory, output.stderr),
      ],
      targets: (like: string) => {
        using db = io.openCacheDb();
        return Promise.resolve(targetValues(db, like));
      },
    };
    /**
     * Строка `words` с выводом `out`: её собственная сессия; результат
     * команды запоминает `memory`.
     */
    const sessionOf = (
      words: readonly string[],
      out: Speech,
      memory: Memory,
    ) =>
      new Session({
        book,
        channel,
        output: out,
        dispatch: (view, order, delivery) =>
          ports.execute(() =>
            runLine(
              order.argv(view.executed(words)),
              lineIo,
              out,
              journal,
              remembering(delivery ?? PRINT, memory),
            )
          ),
        streams: (view, order) => streams(order.argv(view.executed(words))),
        terminal: io.stdinIsTerminal(),
      });
    const walked = walkedWords(argv);
    // Строка через дверь объявляет запись для всей строки: группы
    // значений идут той же дверью (`platform/value-expression.md`).
    const door = walked[0] === ASK_WORD ? [ASK_WORD] : [];
    const values: LineValues = new LineValues(async (words) => {
      const texts: string[] = [];
      const captured: Speech = {
        stdout: (text) => void texts.push(text),
        stderr: speech.stderr,
        refusal: speech.refusal,
      };
      const group = [...door, ...words];
      // Результат группы — значение ключа, а не результат строки.
      const root = registryRoot(
        sessionOf(group, captured, NO_CALLER),
        book,
        parts,
      );
      const outcome = await runChain(group, root, values);
      return { outcome, printed: texts.join("") };
    }, stdin);
    const root = registryRoot(sessionOf(argv, speech, ports.memory), book, {
      ...parts,
      stripped: strippedOf(argv),
    });
    const outcome = await runChain(walked, root, values);
    return printed(outcome, speech);
  };
}
