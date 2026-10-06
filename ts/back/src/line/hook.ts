/**
 * Строки-хуки (`claude-hook-pre-tool-use.md`, «Как находится решение»
 * [D.1–D.5]; `claude-hook-permission-request.md` [D.1]): ведёт их ядро.
 * Внешний путь решает сессия строки, как у любой команды; после её
 * согласия ответ на stdin даёт сам хук. У `pre-tool-use` слова вызова из
 * stdin обходятся той же цепочкой, где на месте сессии — проба
 * `Consultation`: она ничего не исполняет, а слушает исход решения
 * правил. У `permission-request` ответ — вопрос владельцу, и строка ждёт
 * его, не занимая места исполнителей.
 */

import { consentAt } from "../entrypoint/mod.ts";
import {
  ELICITATION,
  type HookWords,
  NOTIFICATION,
  PERMISSION_REQUEST,
  PRE_TOOL_USE,
  STOP,
} from "../frames/mod.ts";
import {
  Allowed,
  askedBy,
  atExecution,
  Denied,
  type HookReply,
  HUMAN_DECIDES,
  NOT_RULED,
  RULE_CHANGE,
  toolCallOf,
  Undecided,
  unparsedLine,
} from "../claudehook/mod.ts";
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
import { entryOf } from "./ahead.ts";
import type { ImageContext, ImageLine } from "./define.ts";
import type { Line } from "./dispatch.ts";
import { itMethod, NO_CALLER } from "./it.ts";
import type { Order } from "./order.ts";
import { printed, type Speech } from "./printed.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { ARGS } from "./tree.ts";
import type { View } from "./view.ts";

/** Путь корня в причине: наследуемое правило пути не имеет. */
const ROOT_RULE = "*";

/** Кто отвечает хуку на слова строки `mpu` глазами ядра. */
export interface Consulting {
  /** Ответ хука на слова строки `mpu` (без самого `mpu`). */
  reply(words: readonly string[]): Promise<HookReply>;
}

/**
 * Обход слов строки той же цепочкой, что у ядра: на месте сессии —
 * `probe`, значения — `values`.
 */
export type ProbeWalk = (
  probe: Line,
  values: ValueEvaluation,
) => Promise<Outcome>;

/** Ответ хука на текст своего stdin. */
export type HookAnswer = (text: string) => Promise<HookReply>;

/**
 * Строки-хуки, чей ответ — вопрос владельцу: ответ на stdin `text`.
 * Один порт на все такие хуки — новый хук добавляет метод, а не поле в
 * каждом звене от сервера до маршрута.
 */
export interface OwnerHooks {
  /** `permission-request` (`claudehook/desk.ts`). */
  permission(text: string): Promise<HookReply>;
  /** `stop` (`claudehook/stop_desk.ts`). */
  stop(text: string): Promise<HookReply>;
  /** `notification` (`claudehook/notify_desk.ts`). */
  notification(text: string): Promise<HookReply>;
  /** `elicitation` (`claudehook/elicitation_desk.ts`). */
  elicitation(text: string): Promise<HookReply>;
}

/** Что строкам-хукам нужно сверх контекста строки. */
export interface HookPorts {
  readonly readStdin: () => Promise<Uint8Array>;
  /** Проба строки `mpu` для `pre-tool-use`. */
  readonly consulting: Consulting;
  /** Вопросы владельцу строк-хуков. */
  readonly owner: OwnerHooks;
}

/**
 * Строка-хук по словам без входа двери; иначе — `otherwise`. Справка и
 * отказы идут обычной цепочкой: подменено только исполнение листа. Хуку
 * `PreToolUse` она отвечает «решается при исполнении»: её исход — ответ
 * на stdin, которого он не видит.
 */
export function hookLineOf(
  said: readonly string[],
  ports: HookPorts,
  otherwise: ImageLine,
): ImageLine {
  const { consulting, owner } = ports;
  const hooks: readonly { hook: HookWords; answer: HookAnswer }[] = [
    {
      hook: PRE_TOOL_USE,
      answer: (text) =>
        toolCallOf(text).reply((words) => consulting.reply(words)),
    },
    { hook: PERMISSION_REQUEST, answer: (text) => owner.permission(text) },
    { hook: STOP, answer: (text) => owner.stop(text) },
    { hook: NOTIFICATION, answer: (text) => owner.notification(text) },
    { hook: ELICITATION, answer: (text) => owner.elicitation(text) },
  ];
  return hooks.reduceRight(
    (rest, { hook, answer }) => hooked(hook, said, ports, answer, rest),
    otherwise,
  );
}

/** Строка хука `hook` с ответом `answer`; не его слова — `otherwise`. */
function hooked(
  hook: HookWords,
  said: readonly string[],
  ports: HookPorts,
  answer: HookAnswer,
  otherwise: ImageLine,
): ImageLine {
  if (!hook.opens(said)) return otherwise;
  return {
    settle: (context: ImageContext) =>
      context.walk((session) =>
        new HookLine(session, context.speech, ports.readStdin, answer)
      ),
    consult: atExecution,
  };
}

/** Строка хука: решение внешнего пути — у сессии, дальше — ответ хука. */
class HookLine implements Line {
  readonly #session: Line;
  readonly #speech: Speech;
  readonly #readStdin: () => Promise<Uint8Array>;
  readonly #answer: HookAnswer;

  constructor(
    session: Line,
    speech: Speech,
    readStdin: () => Promise<Uint8Array>,
    answer: HookAnswer,
  ) {
    this.#session = session;
    this.#speech = speech;
    this.#readStdin = readStdin;
    this.#answer = answer;
  }

  /**
   * stdin читается только после согласия правил на путь хука. Места в
   * пределе строк строка не берёт: исполнения у неё нет, а ответ хука
   * может ждать владельца час (`claude-hook-permission-request.md` [D.8]).
   */
  async dispatch(report: Report, view: View): Promise<Outcome> {
    const code = printed(
      await this.#session.consent(report, view),
      this.#speech,
    );
    if (code !== 0) return report.exit(code);
    const text = new TextDecoder().decode(await this.#readStdin());
    const reply = await this.#answer(text);
    reply.tell(this.#speech);
    return report.exit(reply.code());
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
 * Ответ хука на обычную цепочку: обход `walk` слов `words`, где на месте
 * сессии — проба по правилам `book`.
 */
export async function probedReply(
  book: RuleBook,
  words: readonly string[],
  walk: ProbeWalk,
): Promise<HookReply> {
  const probe = new Consultation(book, words);
  try {
    printed(await walk(probe, AT_EXECUTION_VALUES), probe);
  } catch (err) {
    if (!(err instanceof ValueAtExecution)) throw err;
    return atExecution();
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
class Consultation implements Line, Speech {
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
      return this.#settled(
        report,
        new Undecided(PRE_TOOL_USE.unavailable(err.message)),
      );
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
