/**
 * Исполнение строки (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком, — если
 * позволяют правила подтверждения (`platform/policy.md`).
 */

import type { CommandIo } from "../command/mod.ts";
import {
  type Delivery,
  type InvokeJournal,
  type Invoker,
  JSON_FLAG,
  type Output,
  PRINT,
  runLine,
  streams,
} from "../entrypoint/mod.ts";
import type { RefusalData } from "../frames/mod.ts";
import { GRAMMAR, UNNAMED_REFUSAL } from "../messages/mod.ts";
import {
  type Outcome,
  plainRefusal,
  type Report,
  runChain,
} from "../objects/mod.ts";
import {
  type Address,
  type Channel,
  Human,
  NOBODY,
  PolicyError,
  RuleBook,
  type RuleEntry,
  type Ruling,
} from "../policy/mod.ts";
import { type CliEntry, runJournaled } from "../process/mod.ts";
import {
  isProgram,
  type LineReply,
  parseProgram,
  Placed,
  refusalOf,
  type Root,
} from "../program/mod.ts";
import {
  Capture,
  type Evaluator,
  programCommands,
  programPolicy,
  programRoot,
} from "./program.ts";
import { JSON_STRIPPED, NOTHING_STRIPPED, type Stripped } from "./keyed.ts";
import { registrySeeds } from "./seeds.ts";
import { targetValues } from "../selector/mod.ts";
import { itMethod, type Memory, NO_CALLER, remembering } from "./it.ts";
import { printed, type Speech } from "./printed.ts";
import { Session } from "./session.ts";
export { HUMAN_ONLY } from "./session.ts";
import { LineValues, StdinOnce } from "./value.ts";
import { toDoor } from "./view.ts";
import { Ahead, entryOf, redirected } from "./ahead.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { registryNodes, registryRoot, ruleLinks } from "./tree.ts";
import { Image, ImageError, type ImageMethod } from "../image/mod.ts";
import type { Commands, MethodSource } from "../program/mod.ts";
import { imageLineOf } from "./define.ts";
import { callsImage } from "./methods.ts";

export type { RootMethod } from "./rules.ts";
export {
  type Evaluator,
  IN_PLACE_PROGRAMS,
  programCommands,
} from "./program.ts";
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
export function policyTree(
  file: string | undefined,
  image: readonly ImageMethod[] = [],
): NodeRuling[] {
  using book = RuleBook.open(file, registrySeeds());
  const owned = new Set(book.list().map((rule) => rule.path));
  return registryNodes(image).map((node) => {
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
  /**
   * Где исполняется сама команда: у сервера строк — исполнитель из пула
   * (`platform/line-executor.md`), у прочих — `IN_PLACE`.
   */
  readonly invoker: Invoker;
  /** Методы корня, которые даёт дверь строки (у прямого — нет). */
  readonly rootMethods: readonly RootMethod[];
  /** Память вызывающего строки: её результат и ответ на `it`. */
  readonly memory: Memory;
  /**
   * Отказ строки объектом — вызывающему, перед его текстом в stderr
   * (`platform/refusal-object.md`); у прямого вызова объект не нужен.
   */
  readonly refusal: (data: RefusalData) => void;
  /**
   * Где исполняется программа (`platform/evaluator.md`): у сервера строк
   * — исполнитель вне предела пула, у прочих — `IN_PLACE_PROGRAMS`.
   */
  readonly evaluator: Evaluator;
  /** Образ строки (`platform/image.md`); нет — образ пуст, писать некуда. */
  readonly image?: ImagePorts;
}

/** Образ строки: файл, кто пишет, часы и снимок дерева. */
export interface ImagePorts {
  /** Файл образа; живёт дольше строки — сверка `data_version` у него. */
  readonly image: Image;
  /** Канал автора определения: `human`, `agent`, `web`. */
  readonly author: string;
  readonly now: () => Date;
  /** Образ изменился: снимок дерева переписывается. */
  readonly changed: () => Promise<void>;
}

/** Образа нет: пуст, запись — отказ «нет HOME». */
function noImage(): ImagePorts {
  return {
    image: Image.at(undefined),
    author: "human",
    now: () => new Date(),
    changed: () => Promise.resolve(),
  };
}

/**
 * Как исполняется команда строки: чья запись журнала, в какой очереди и
 * куда уходит результат, если строка не выбрала доставку сама.
 */
interface Running {
  readonly journal: InvokeJournal;
  readonly execute: (run: () => Promise<number>) => Promise<number>;
  readonly delivery: Delivery;
  /** Строка `ask` без двери: куда её отослать. */
  readonly redirect: (report: Report) => Promise<Outcome>;
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
    const imaging = ports.image ?? noImage();
    let methods: readonly ImageMethod[];
    try {
      methods = imaging.image.methods();
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      plainRefusal(UNNAMED_REFUSAL, err.message).tell(speech);
      return 1;
    }
    const sources = methods.map((method) => method.source());
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
      image: methods,
    };
    /** Как исполняется команда самой строки: её журнал, очередь, печать. */
    const own: Running = {
      journal,
      execute: ports.execute,
      delivery: PRINT,
      redirect: () => toDoor(),
    };
    /**
     * Строка `words` с выводом `out`: её собственная сессия; результат
     * команды запоминает `memory`, исполняется она так, как велит
     * `running`.
     */
    const sessionOf = (
      words: readonly string[],
      out: Speech,
      memory: Memory,
      running: Running = own,
    ) =>
      new Session({
        book,
        channel,
        output: out,
        dispatch: (view, order, delivery) =>
          running.execute(() =>
            runLine(
              order.argv(view.executed(words)),
              lineIo,
              out,
              running.journal,
              remembering(delivery ?? running.delivery, memory),
              ports.invoker,
            )
          ),
        streams: (view, order) => streams(order.argv(view.executed(words))),
        terminal: io.stdinIsTerminal(),
        redirect: running.redirect,
      });
    const walked = walkedWords(argv);
    // Строка через дверь объявляет запись для всей строки: группы
    // значений идут той же дверью (`platform/value-expression.md`).
    const entry = entryOf(walked);
    const door = entry.words;
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
    const said = walked.slice(door.length);
    /**
     * Команда программы — отдельной строкой той же дверью: правила в
     * момент отправки, своя запись журнала, `it`; место в очереди строк
     * у неё то же, что у программы.
     */
    const core = async (words: readonly string[]): Promise<LineReply> => {
      const line = [...door, ...words];
      const capture = new Capture();
      let reply: LineReply = { exit: 1 };
      await runJournaled(
        line,
        async (sub, _io, out, subJournal) => {
          const texts: string[] = [];
          const heard: Speech = {
            stdout: (text) => void texts.push(text),
            stderr: out.stderr,
            refusal: speech.refusal,
          };
          const running = {
            journal: subJournal,
            execute: immediately,
            delivery: capture,
            redirect: redirected(said, heard),
          };
          const subRoot = registryRoot(
            sessionOf(sub, heard, ports.memory, running),
            book,
            parts,
          );
          const code = printed(await runChain(sub, subRoot, values), heard);
          reply = capture.reply(code, texts.join(""));
          return code;
        },
        lineIo,
        journal.log,
        output,
      );
      return reply;
    };
    const commands = programCommands(sources);
    const context = {
      said,
      view: entry.view,
      book,
      channel,
      speech,
      image: imaging.image,
      methods,
      commands,
      root: programRoot(root),
      author: imaging.author,
      now: imaging.now,
      changed: imaging.changed,
    };
    return await imageLineOf(said).settle(context, async () => {
      if (!isProgram(said, commands) && !callsImage(said, methods)) {
        return printed(await runChain(walked, root, values), speech);
      }
      return await runProgramLine(said, context.root, {
        ports,
        speech,
        io: lineIo,
        journal,
        core,
        decide: (links) => book.decide(links),
        ahead: entry.ahead,
        commands,
        sources,
      });
    });
  };
}

/** Что нужно строке-программе в ядре. */
interface ProgramLine {
  readonly ports: LinePorts;
  readonly speech: Speech;
  readonly io: CommandIo;
  readonly journal: InvokeJournal;
  readonly core: (words: readonly string[]) => Promise<LineReply>;
  /** Решение правил для звеньев пути — обходу до исполнения. */
  readonly decide: (links: readonly string[]) => Ruling;
  /** Адрес обхода: в двери или без неё. */
  readonly ahead: Address;
  /** Дерево команд с методами образа — для разбора. */
  readonly commands: Commands;
  /** Методы образа — исполнителю программы. */
  readonly sources: readonly MethodSource[];
}

/**
 * Строка-программа: отказы до исполнения — здесь (разбор — код 2, обход
 * достижимых команд правилами — `platform/ask-composite.md`); исполнение —
 * месту исполнения программ, в очереди строк одним местом.
 */
async function runProgramLine(
  words: readonly string[],
  root: Root,
  line: ProgramLine,
): Promise<number> {
  let program;
  try {
    program = parseProgram(words, line.commands, root);
  } catch (err) {
    if (!(err instanceof Placed)) throw err;
    refusalOf(words, err).tell(line.speech);
    return 2;
  }
  const ahead = new Ahead(words);
  program.reach(ahead);
  const finding = await ahead.verdict(line.decide, line.ahead);
  return await finding.settle(line.speech, () => runEvaluated(words, line));
}

/** Программа, прошедшая проверки: запись журнала и исполнение. */
async function runEvaluated(
  words: readonly string[],
  line: ProgramLine,
): Promise<number> {
  line.journal.nativeCall(programPolicy(words));
  return await line.ports.execute(async () => {
    const end = await line.ports.evaluator.evaluate(
      words,
      line.io,
      line.speech,
      line.core,
      line.journal,
      line.sources,
    );
    if (end.refusal !== null) {
      line.speech.refusal(end.refusal);
      line.speech.stderr(`${end.refusal.text}\n`);
    }
    return end.exit;
  });
}
