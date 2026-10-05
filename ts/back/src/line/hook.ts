/**
 * Строка `claude-hook pre-tool-use` (`claude-hook-pre-tool-use.md`, «Как
 * находится решение» [D.1–D.5]): ведёт её ядро — у него правила, дверь и
 * образ. Внешний путь решает сессия строки, как у любой команды; после
 * её согласия слова вызова из stdin обходятся той же цепочкой, где на
 * месте сессии — проба `Consultation`: она ничего не исполняет, а
 * слушает исход решения правил.
 */

import { consentAt } from "../entrypoint/mod.ts";
import { HOOK_WORDS, unavailable } from "../frames/mod.ts";
import {
  Allowed,
  askedBy,
  AT_EXECUTION,
  Denied,
  type HookReply,
  HUMAN_DECIDES,
  NOT_RULED,
  PROGRAM_UNSEEN,
  RULE_CHANGE,
  toolCallOf,
  Undecided,
  unparsedLine,
} from "../claudehook/mod.ts";
import type { ImageMethod } from "../image/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import {
  line as lineText,
  type Method,
  type Outcome,
  type Report,
  ROOT_TEXT,
  type ValueEvaluation,
} from "../objects/mod.ts";
import {
  type Execution,
  NOBODY,
  PolicyError,
  type RuleBook,
  type Ruling,
} from "../policy/mod.ts";
import { type Commands, isProgram } from "../program/mod.ts";
import { entryOf } from "./ahead.ts";
import {
  type ImageContext,
  type ImageLine,
  imageLineOf,
  NOT_IMAGE,
} from "./define.ts";
import type { Line } from "./dispatch.ts";
import { itMethod, NO_CALLER } from "./it.ts";
import { callsImage } from "./methods.ts";
import type { Order } from "./order.ts";
import { printed, type Speech } from "./printed.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { syncLineOf } from "./sync.ts";
import { ARGS } from "./tree.ts";
import type { View } from "./view.ts";

/** Путь корня в причине: наследуемое правило пути не имеет. */
const ROOT_RULE = "*";

/** Что пробе нужно от строки ядра, чтобы обойти слова вызова. */
export interface Consulting {
  readonly book: RuleBook;
  /** Дерево команд с методами образа — для «программа ли». */
  readonly commands: Commands;
  readonly methods: readonly ImageMethod[];
  /** Слова строки без `--json` — как их видит ядро (`originOf`). */
  readonly walked: (words: readonly string[]) => readonly string[];
  /**
   * Обход слов `words` той же цепочкой, что у строки: то же дерево, та же
   * книга, тот же разбор двери и `--json`; на месте сессии — `probe`.
   */
  readonly walk: (
    words: readonly string[],
    probe: Line,
    values: ValueEvaluation,
  ) => Promise<Outcome>;
}

/** Что строке хука нужно сверх контекста строки: stdin и проба. */
export interface HookPorts {
  readonly readStdin: () => Promise<Uint8Array>;
  readonly consulting: Consulting;
}

/**
 * Строка хука по словам без входа двери; иначе — `otherwise`. Справка и
 * отказы идут обычной цепочкой: подменено только исполнение листа.
 */
export function hookLineOf(
  said: readonly string[],
  ports: HookPorts,
  otherwise: ImageLine,
): ImageLine {
  if (!HOOK_WORDS.every((word, i) => said[i] === word)) return otherwise;
  return {
    settle: (context: ImageContext) =>
      context.walk((session) => new HookLine(session, context.speech, ports)),
  };
}

/** Строка хука: решение внешнего пути — у сессии, дальше — проба. */
class HookLine implements Line {
  readonly #session: Line;
  readonly #speech: Speech;
  readonly #ports: HookPorts;

  constructor(session: Line, speech: Speech, ports: HookPorts) {
    this.#session = session;
    this.#speech = speech;
    this.#ports = ports;
  }

  /** stdin читается только после согласия правил на путь хука. */
  async dispatch(report: Report, view: View): Promise<Outcome> {
    const code = printed(
      await this.#session.consent(report, view),
      this.#speech,
    );
    if (code !== 0) return report.exit(code);
    const text = new TextDecoder().decode(await this.#ports.readStdin());
    const consulting = this.#ports.consulting;
    const reply = await toolCallOf(text).reply((words) =>
      consulted(words, consulting)
    );
    reply.tell(this.#speech);
    return report.exit(0);
  }

  terminal(): boolean {
    return this.#session.terminal();
  }

  streams(view: View, order: Order): boolean {
    return this.#session.streams(view, order);
  }

  /** Результат — ответ хука, а не данные: отбора у него нет. */
  select(report: Report, view: View): Promise<Outcome> {
    return this.dispatch(report, view);
  }

  listRules(report: Report): Promise<Outcome> {
    return this.#session.listRules(report);
  }

  change(
    report: Report,
    path: Parameters<Line["change"]>[1],
    change: Parameters<Line["change"]>[2],
  ): Promise<Outcome> {
    return this.#session.change(report, path, change);
  }

  consent(report: Report, view: View): Promise<Outcome> {
    return this.#session.consent(report, view);
  }
}

/**
 * Ответ хука для слов строки `mpu` (без самого `mpu`): программа и
 * строка образа отсеиваются функциями ядра, прочее решает обход с пробой.
 */
export async function consulted(
  words: readonly string[],
  consulting: Consulting,
): Promise<HookReply> {
  const walked = consulting.walked(words);
  const said = walked.slice(entryOf(walked).words.length);
  if (said.length === 0 || said[0] === GRAMMAR.run) {
    return new Undecided(PROGRAM_UNSEEN);
  }
  if (
    isProgram(said, consulting.commands) ||
    callsImage(said, consulting.methods) ||
    imageLineOf(said, syncLineOf(said)) !== NOT_IMAGE
  ) {
    return new Undecided(AT_EXECUTION);
  }
  const probe = new Consultation(consulting.book, words);
  try {
    printed(await consulting.walk(words, probe, AT_EXECUTION_VALUES), probe);
  } catch (err) {
    if (!(err instanceof ValueAtExecution)) throw err;
    return new Undecided(AT_EXECUTION);
  }
  return probe.reply();
}

/** Значение-выражение в строке вызова: что исполнится, не видно. */
class ValueAtExecution extends Error {
  override name = "ValueAtExecution";
}

/** Значения пробы: группа и `stdin` не вычисляются, обход кончается. */
const AT_EXECUTION_VALUES: ValueEvaluation = {
  group: () => Promise.reject(new ValueAtExecution("группа значения")),
  stdin: () => Promise.reject(new ValueAtExecution("stdin значением")),
};

/**
 * Методы корня двери и `it` в обходе пробы: те же имя и справка, но
 * ничего не делают — конец строки у них решают не правила.
 */
export function standingMethods(
  methods: readonly RootMethod[],
): Method<Line>[] {
  return [
    ...methods.map((method) =>
      rootMethod({
        selector: method.selector,
        doc: method.doc,
        produce: () => Promise.resolve(null),
      })
    ),
    itMethod(NO_CALLER, () => {}),
  ];
}

/**
 * Проба строки без исполнения (`Consultation`): на месте сессии в
 * обходе, запоминает ответ хука. Ответ, пока обход её не спросил, —
 * «правила строку не решают»; отказ обхода — «строка не разобрана».
 */
export class Consultation implements Line, Speech {
  readonly #book: RuleBook;
  /** Слова строки — её согласие спрашивается у команды по ним. */
  readonly #words: readonly string[];
  #reply: HookReply = new Undecided(NOT_RULED);

  constructor(book: RuleBook, words: readonly string[]) {
    this.#book = book;
    this.#words = [...words];
  }

  /** Ответ хука после обхода. */
  reply(): HookReply {
    return this.#reply;
  }

  /** Текст обхода не печатается: хук говорит только ответом. */
  stdout() {}

  stderr() {}

  /** Отказ обхода: причина — вид отказа, без его текста со значениями. */
  refusal(data: { readonly reason: string }) {
    this.#reply = new Undecided(unparsedLine(data.reason));
  }

  dispatch(report: Report, view: View, order: Order): Promise<Outcome> {
    return this.#consented(report, view, order);
  }

  select(report: Report, view: View, order: Order): Promise<Outcome> {
    return this.#consented(report, view, order);
  }

  consent(report: Report): Promise<Outcome> {
    return this.#ruled(report);
  }

  listRules(report: Report): Promise<Outcome> {
    return this.#ruled(report);
  }

  /** Изменение правил хук не решает: вопрос каналу не задаётся. */
  change(report: Report): Promise<Outcome> {
    return this.#settled(report, new Undecided(RULE_CHANGE));
  }

  terminal(): boolean {
    return false;
  }

  streams(): boolean {
    return false;
  }

  /** Согласие команды: правила — решение пути, человек — без решения. */
  #consented(report: Report, view: View, order: Order): Promise<Outcome> {
    return consentAt(order.argv(view.executed(this.#words))).settle({
      rules: () => this.#ruled(report),
      human: () => this.#settled(report, new Undecided(HUMAN_DECIDES)),
    });
  }

  /** Решение правил пути у адреса обхода, канал без человека. */
  async #ruled(report: Report): Promise<Outcome> {
    let ruling: Ruling;
    try {
      ruling = this.#book.decide(report.links());
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      return this.#settled(report, new Undecided(unavailable(err.message)));
    }
    const reply = await ruling.settle(
      execution(report, ruling),
      NOBODY,
      entryOf([]).ahead,
    );
    return this.#settled(report, reply);
  }

  #settled(report: Report, reply: HookReply): Promise<Outcome> {
    this.#reply = reply;
    return Promise.resolve(report.exit(0));
  }
}

/**
 * Строка под решением глазами пробы: путь без `<args>`, исход — ответ
 * хука. Путь выигравшего правила берётся здесь, в одном месте.
 */
function execution(report: Report, ruling: Ruling): Execution<HookReply> {
  const path = report.links().filter((link) => link !== ARGS);
  const text = lineText(ROOT_TEXT, path);
  const won = ruling.record().won ?? ROOT_RULE;
  return {
    text,
    run: () =>
      Promise.resolve(new Allowed(`${text}: разрешено правилом «${won}»`)),
    refuse: (_reason, refused) => Promise.resolve(new Denied(refused)),
    redirect: () => Promise.resolve(new Undecided(askedBy(won))),
  };
}
