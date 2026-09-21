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
} from "./context.ts";
import { isRecord, parsedJson } from "./json.ts";

/** Первый кадр клиента как он уходит по проводу. */
export interface FirstFrame extends ContextFields {
  readonly words: readonly string[];
  /** Абсолютный каталог клиента. */
  readonly cwd: string;
  /** Есть ли у клиента, кого спросить; не сказано — нет. */
  readonly human: boolean;
}

/** Разобранный первый кадр: строка, место и что принёс вызывающий. */
export interface LineRequest {
  readonly words: readonly string[];
  readonly cwd: string;
  readonly human: boolean;
  /** Ввод, терминальность и переменные клиента. */
  readonly context: CallContext;
}

/** Кадр сервера. */
export type ServerFrame =
  | { readonly out: string }
  | { readonly err: string }
  | { readonly ask: string; readonly ticket?: string }
  | { readonly exit: number };

/**
 * Первый кадр строки.
 *
 * @param data данные кадра как их отдал сокет
 * @throws BadFrame — не JSON-объект, нет `words` или `cwd`, `cwd` не
 *   абсолютный, `human` не булево, либо контекст вызова непринимаем
 *   (`callContextOf`)
 */
export function lineRequest(data: unknown): LineRequest {
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
  return { words: [...words], cwd, human, context: callContextOf(frame) };
}

/** Ответ на вопрос из кадра клиента; кадр не ответ — `undefined`. */
export function answerOf(data: unknown): string | undefined {
  const frame = parsedJson(data);
  if (!isRecord(frame) || typeof frame.answer !== "string") return undefined;
  return frame.answer;
}

/**
 * Кадр сервера глазами клиента (`fixtures/back-rpc/schema.json`,
 * `line.server`).
 *
 * @param data данные кадра как их отдал сокет
 * @throws BadFrame — не объект JSON или не один из четырёх видов
 */
export function serverFrameOf(data: unknown): ServerFrame {
  const frame = parsedJson(data);
  if (!isRecord(frame)) throw new BadFrame("кадр сервера не объект JSON");
  const keys = Object.keys(frame);
  if (keys.length !== 1) throw new BadFrame("у кадра сервера не одно поле");
  const [key] = keys;
  const value = frame[key];
  if (key === "exit" && typeof value === "number" && Number.isInteger(value)) {
    return { exit: value };
  }
  if (typeof value !== "string") throw new BadFrame(`кадр ${key} не строка`);
  if (key === "out") return { out: value };
  if (key === "err") return { err: value };
  if (key === "ask") return { ask: value };
  throw new BadFrame(`неизвестный кадр ${key}`);
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
  | { readonly stdout: string; readonly stderr: string; readonly exit: number }
  | {
    readonly stdout: string;
    readonly stderr: string;
    readonly ask: string;
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
  const { stdout, stderr, exit, ask, ticket } = body;
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new BadFrame("в собранном ответе нет потоков");
  }
  if (typeof exit === "number" && Number.isInteger(exit)) {
    return { stdout, stderr, exit };
  }
  if (typeof ask === "string" && typeof ticket === "string") {
    return { stdout, stderr, ask, ticket };
  }
  throw new BadFrame("в собранном ответе нет итога");
}
