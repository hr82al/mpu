/**
 * Кадры строки (`platform/back-rpc.md`, «Строка») — данные границы:
 * разбор входящих здесь, дальше — объекты строки и канала.
 */

import { BadFrame } from "./bad.ts";
import {
  type CallContext,
  callContextOf,
  CONTEXT_FIELDS,
  CONTEXT_IN_ANSWER,
  type ContextFields,
  FRAME_INPUT,
  type InputSource,
} from "./context.ts";
import { isRecord, parsedJson } from "./json.ts";

/** Первый кадр клиента как он уходит по проводу. */
export interface FirstFrame extends ContextFields {
  readonly words: readonly string[];
  /** Абсолютный каталог клиента. */
  readonly cwd: string;
  /** Есть ли у клиента, кого спросить; не сказано — нет. */
  readonly human: boolean;
  /**
   * Как клиент называет себя (`platform/it.md`): `ppid:…`, `mcp:…`. Нет —
   * у строки нет вызывающего, её результат не запоминается.
   */
  readonly caller?: string;
}

/** Разобранный первый кадр: строка, место и что принёс вызывающий. */
export interface LineRequest {
  readonly words: readonly string[];
  readonly cwd: string;
  readonly human: boolean;
  /** Ввод, терминальность и переменные клиента. */
  readonly context: CallContext;
  /** Как клиент назвал себя; не назвал — `undefined`. */
  readonly caller: string | undefined;
}

/** Вид вопроса: видимый ответ или скрытый (`platform/line-prompt.md`). */
export type AskKind = "line" | "secret";

/**
 * Вид вопроса из кадра: нет поля или `line` — умолчание, и в разобранном
 * кадре его тоже нет. Чужое значение — плохой кадр, а не молчаливое
 * «видимый»: смысл вида в том, чтобы скрытое не стало видимым по ошибке.
 *
 * @throws BadFrame — вид не `line` и не `secret`
 */
function askKindOf(value: unknown): AskKind | undefined {
  if (value === undefined || value === "line") return undefined;
  if (value === "secret") return "secret";
  throw new BadFrame("вид вопроса не line и не secret");
}

/**
 * Кадр вопроса. Вид `line` в кадр не пишется: он и есть умолчание, а
 * клиент прежней версии, не знающий поля, должен видеть тот же кадр,
 * что и раньше (`platform/line-prompt.md`, инварианты).
 *
 * @param ask текст вопроса
 * @param kind вид ответа
 * @param ticket номер подтверждения, если вопрос задан им
 */
export function askFrame(
  ask: string,
  kind: AskKind,
  ticket?: string,
): ServerFrame {
  const asked = kind === "secret" ? { ask, kind } : { ask };
  return ticket === undefined ? asked : { ...asked, ticket };
}

/**
 * Отказ строки объектом (`platform/refusal-object.md`): вид, исправленная
 * строка словами (нет подсказки — `null`), ближайшие и текст stderr без
 * перевода строки.
 */
export interface RefusalData {
  readonly reason: string;
  readonly hint: readonly string[] | null;
  readonly candidates: readonly string[];
  readonly text: string;
}

/** Кадр сервера. */
export type ServerFrame =
  | { readonly out: string }
  | { readonly err: string }
  | { readonly refusal: RefusalData }
  | {
    readonly ask: string;
    readonly kind?: AskKind;
    readonly ticket?: string;
  }
  | { readonly clip: string }
  /** Строке нужен ввод клиента (`platform/stdin-on-request.md`). */
  | { readonly stdinRequest: true }
  | { readonly exit: number };

/** Кадр запроса ввода: один на строку. */
export const STDIN_REQUEST: ServerFrame = { stdinRequest: true };

/**
 * Первый кадр строки.
 *
 * @param data данные кадра как их отдал сокет
 * @param input откуда транспорт берёт ввод строки (`callContextOf`)
 * @throws BadFrame — не JSON-объект, нет `words` или `cwd`, `cwd` не
 *   абсолютный, `human` не булево, `caller` не строка, либо контекст
 *   вызова непринимаем
 *   (`callContextOf`)
 */
export function lineRequest(
  data: unknown,
  input: InputSource = FRAME_INPUT,
): LineRequest {
  const frame = parsedJson(data);
  if (!isRecord(frame)) throw new BadFrame("кадр не объект JSON");
  const { words, cwd, human = false } = frame;
  if (
    !Array.isArray(words) || !words.every((word) => typeof word === "string")
  ) {
    throw new BadFrame("words — не список строк");
  }
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw new BadFrame("cwd — не абсолютный путь");
  }
  if (typeof human !== "boolean") throw new BadFrame("human — не булево");
  const { caller } = frame;
  if (caller !== undefined && typeof caller !== "string") {
    throw new BadFrame("caller — не строка");
  }
  return {
    words: [...words],
    cwd,
    human,
    context: callContextOf(frame, input),
    caller,
  };
}

/** Ответ на вопрос из кадра клиента; кадр не ответ — `undefined`. */
export function answerOf(data: unknown): string | undefined {
  const frame = parsedJson(data);
  if (!isRecord(frame) || typeof frame.answer !== "string") return undefined;
  return frame.answer;
}

/** Ввод из кадра клиента `stdin`; кадр не ввод — `undefined`. */
export function stdinOf(data: unknown): string | undefined {
  const frame = parsedJson(data);
  if (!isRecord(frame) || typeof frame.stdin !== "string") return undefined;
  return frame.stdin;
}

/**
 * Кадр сервера глазами клиента (`fixtures/back-rpc/schema.json`,
 * `line.server`).
 *
 * @param data данные кадра как их отдал сокет
 * @throws BadFrame — не объект JSON или не один из видов кадра
 */
export function serverFrameOf(data: unknown): ServerFrame {
  const frame = parsedJson(data);
  if (!isRecord(frame)) throw new BadFrame("кадр сервера не объект JSON");
  const { ask, kind, ...rest } = frame;
  // Вид вопроса — не отдельный кадр, а уточнение к `ask`; прочие кадры
  // остаются однополевыми.
  if (typeof ask === "string" && Object.keys(rest).length === 0) {
    const asked = askKindOf(kind);
    return asked === undefined ? { ask } : { ask, kind: asked };
  }
  const keys = Object.keys(frame);
  if (keys.length !== 1) throw new BadFrame("у кадра сервера не одно поле");
  const [key] = keys;
  const value = frame[key];
  if (key === "refusal") return { refusal: refusalOf(value) };
  if (key === "exit" && typeof value === "number" && Number.isInteger(value)) {
    return { exit: value };
  }
  if (key === "stdinRequest") {
    if (value !== true) throw new BadFrame("кадр stdinRequest не true");
    return { stdinRequest: true };
  }
  if (typeof value !== "string") throw new BadFrame(`кадр ${key} не строка`);
  if (key === "out") return { out: value };
  if (key === "err") return { err: value };
  if (key === "clip") return { clip: value };
  throw new BadFrame(`неизвестный кадр ${key}`);
}

/** Список строк из JSON; иное — `undefined`. */
function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((one) => typeof one === "string")) return undefined;
  return [...value];
}

/**
 * Отказ-объект из кадра или собранного ответа.
 *
 * @throws BadFrame — не объект или поле не своего вида
 */
function refusalOf(value: unknown): RefusalData {
  if (!isRecord(value)) throw new BadFrame("отказ не объект JSON");
  const { reason, hint, candidates, text } = value;
  const words = hint === null ? null : stringsOf(hint);
  const near = stringsOf(candidates);
  if (
    typeof reason !== "string" || typeof text !== "string" ||
    words === undefined || near === undefined
  ) {
    throw new BadFrame("у отказа поле не своего вида");
  }
  return { reason, hint: words, candidates: near, text };
}

/**
 * Тело ответа на вопрос строки простым HTTP (`platform/back-http-line.md`):
 * номер и ответ. Не разобралось — пустой номер (такого нет — 404), ответа
 * нет — пустой ответ («нет»).
 *
 * @throws BadFrame — в теле поля контекста вызова: он пришёл первым
 *   запросом и живёт до конца строки (`platform/call-context.md`), а
 *   номер при этом цел, и отказ обязан это различать
 */
export function ticketAnswerOf(
  data: unknown,
): { readonly ticket: string; readonly answer: string } {
  const body = parsedJson(data);
  if (!isRecord(body)) return { ticket: "", answer: "" };
  if (CONTEXT_FIELDS.some((name) => name in body)) {
    throw new BadFrame("контекст вызова в теле ответа", CONTEXT_IN_ANSWER);
  }
  const { ticket, answer } = body;
  return {
    ticket: typeof ticket === "string" ? ticket : "",
    answer: typeof answer === "string" ? answer : "",
  };
}

/**
 * Собранный ответ строки простым HTTP (`platform/back-http-line.md`,
 * `Accept: application/json`): потоки и итог — код или вопрос с номером.
 */
export type Collected =
  | {
    readonly stdout: string;
    readonly stderr: string;
    readonly exit: number;
    /** Отказ строки объектом; строка не отказана — поля нет. */
    readonly refusal?: RefusalData;
  }
  | {
    readonly stdout: string;
    readonly stderr: string;
    readonly ask: string;
    /** Вид ответа; `line` — умолчание, и поля тогда нет. */
    readonly kind?: AskKind;
    readonly ticket: string;
  };

/**
 * Собранный ответ из тела.
 *
 * @throws BadFrame — не объект, нет потоков или нет итога
 */
export function collectedOf(data: unknown): Collected {
  const body = parsedJson(data);
  if (!isRecord(body)) throw new BadFrame("собранный ответ не объект JSON");
  const { stdout, stderr, exit, ask, kind, ticket, refusal } = body;
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new BadFrame("в собранном ответе нет потоков");
  }
  if (typeof exit === "number" && Number.isInteger(exit)) {
    // Поле границы: у строки без отказа его нет вовсе.
    return refusal === undefined
      ? { stdout, stderr, exit }
      : { stdout, stderr, exit, refusal: refusalOf(refusal) };
  }
  if (typeof ask === "string" && typeof ticket === "string") {
    // Вид вопроса доезжает и этим трактом: иначе скрытый ответ читался
    // бы с эхом (`platform/line-prompt.md`).
    const asked = askKindOf(kind);
    return asked === undefined
      ? { stdout, stderr, ask, ticket }
      : { stdout, stderr, ask, kind: asked, ticket };
  }
  throw new BadFrame("в собранном ответе нет итога");
}
