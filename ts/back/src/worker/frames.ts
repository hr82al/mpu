/**
 * Кадры между ядром и исполнителем строки (`platform/line-executor.md`,
 * «Пул и протокол»): NDJSON по stdin/stdout исполнителя. Это данные
 * границы — разбираются здесь один раз, дальше идут значениями типов.
 */

import { isRecord, parsedJson } from "../frames/json.ts";
import { BadFrame, type RefusalData, refusalOf } from "../frames/mod.ts";
import type { LineReply } from "../program/mod.ts";

/**
 * Что исполнить: путь команды, её аргументы, каталог строки и поля
 * контекста вызова в той же форме, что у первого кадра строки
 * (`platform/call-context.md`), — их разбирает тот же разбор контекста.
 * Ввод исполнитель всегда запрашивает: его держит ядро.
 */
export interface Order {
  readonly path: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * Что исполнить программой (`platform/evaluator.md`, «Где исполняется»):
 * её слова. Контекст вызова ей не нужен — окружения она не касается,
 * команды исполняет ядро.
 */
export interface Evaluation {
  readonly words: readonly string[];
}

/** Вид вопроса исполнителя; `copy` — просьба в буфер обмена. */
export type AskKind = "line" | "secret" | "copy";

/**
 * Исход команды у исполнителя: значение результата, отказ команды
 * готовым текстом с кодом или падение с сообщением; у программы — код и
 * отказ-объект (нет — `null`).
 */
export type Outcome =
  | { readonly value: unknown }
  | { readonly code: 1 | 2; readonly stderr: string }
  | { readonly crash: string }
  | { readonly exit: number; readonly refusal: RefusalData | null };

/** Кадр ядра исполнителю. */
export type HostFrame =
  | { readonly run: Order }
  | { readonly evaluate: Evaluation }
  /** Ответ ядра на строку команды программы. */
  | { readonly lined: LineReply }
  /** Ответ человека; `null` — спросить некого. */
  | { readonly answer: string | null }
  /** Ввод строки целиком, текстом (ввод строки приходит JSON-строкой). */
  | { readonly stdin: string }
  | { readonly stop: true };

/** Кадр исполнителя ядру. */
export type WorkerFrame =
  | { readonly out: string }
  | { readonly err: string }
  /** Строка хода исполнения (`io.progress`): её печатает точка входа. */
  | { readonly progress: string }
  | { readonly note: string }
  | { readonly ask: { readonly kind: AskKind; readonly text: string } }
  | { readonly stdin: true }
  /** Команда программы — ядру отдельной строкой. */
  | { readonly line: readonly string[] }
  | { readonly result: Outcome };

/** Строка не разобралась как кадр своей стороны. */
export class BadWorkerFrame extends Error {
  override name = "BadWorkerFrame";
}

/** Кадр строкой NDJSON. */
export function encode(frame: HostFrame | WorkerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function recordOf(line: string): Record<string, unknown> {
  const value = parsedJson(line);
  if (!isRecord(value)) throw new BadWorkerFrame("кадр — не объект JSON");
  return value;
}

function stringsOf(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) {
    throw new BadWorkerFrame(`${name} — не список строк`);
  }
  return value;
}

function evaluationOf(evaluate: Record<string, unknown>): Evaluation {
  return { words: stringsOf(evaluate.words, "words") };
}

/** Ответ ядра на строку команды: данные с командой либо код. */
function linedOf(lined: Record<string, unknown>): LineReply {
  if (typeof lined.exit === "number") return { exit: lined.exit };
  const { data, command, shown } = lined;
  if (typeof shown !== "string") throw new BadWorkerFrame("lined без текста");
  if (command === null) return { data, command: null, shown };
  if (!isRecord(command)) throw new BadWorkerFrame("lined без команды");
  return {
    data,
    command: {
      path: stringsOf(command.path, "path"),
      argv: stringsOf(command.argv, "argv"),
    },
    shown,
  };
}

function orderOf(run: Record<string, unknown>): Order {
  if (typeof run.cwd !== "string") throw new BadWorkerFrame("run без каталога");
  if (!isRecord(run.context)) throw new BadWorkerFrame("run без контекста");
  return {
    path: stringsOf(run.path, "path"),
    args: stringsOf(run.args, "args"),
    cwd: run.cwd,
    context: run.context,
  };
}

/**
 * Кадр ядра из строки NDJSON.
 *
 * @throws BadWorkerFrame — не кадр ядра
 */
export function hostFrameOf(line: string): HostFrame {
  const frame = recordOf(line);
  if (isRecord(frame.run)) return { run: orderOf(frame.run) };
  if (isRecord(frame.evaluate)) {
    return { evaluate: evaluationOf(frame.evaluate) };
  }
  if (isRecord(frame.lined)) return { lined: linedOf(frame.lined) };
  if (typeof frame.answer === "string" || frame.answer === null) {
    return { answer: frame.answer };
  }
  if (typeof frame.stdin === "string") return { stdin: frame.stdin };
  if (frame.stop === true) return { stop: true };
  throw new BadWorkerFrame("незнакомый кадр ядра");
}

/** Отказ-объект программы; не объект отказа — кадр не свой. */
function refusalIn(value: unknown): RefusalData | null {
  if (value === null) return null;
  try {
    return refusalOf(value);
  } catch (err) {
    if (!(err instanceof BadFrame)) throw err;
    throw new BadWorkerFrame(`отказ программы: ${err.message}`);
  }
}

function outcomeOf(value: unknown): Outcome {
  if (!isRecord(value)) throw new BadWorkerFrame("result — не объект");
  if (typeof value.crash === "string") return { crash: value.crash };
  if (typeof value.exit === "number") {
    return { exit: value.exit, refusal: refusalIn(value.refusal) };
  }
  if ("code" in value) {
    if (value.code !== 1 && value.code !== 2) {
      throw new BadWorkerFrame("код отказа не 1 и не 2");
    }
    if (typeof value.stderr !== "string") {
      throw new BadWorkerFrame("отказ без текста");
    }
    return { code: value.code, stderr: value.stderr };
  }
  // Результат `undefined` JSON не пишет вовсе: поля нет — значения нет.
  return { value: value.value };
}

function askOf(value: Record<string, unknown>): WorkerFrame {
  const { kind, text } = value;
  if (kind !== "line" && kind !== "secret" && kind !== "copy") {
    throw new BadWorkerFrame("незнакомый вид вопроса");
  }
  if (typeof text !== "string") throw new BadWorkerFrame("вопрос без текста");
  return { ask: { kind, text } };
}

/**
 * Кадр исполнителя из строки NDJSON.
 *
 * @throws BadWorkerFrame — не кадр исполнителя
 */
export function workerFrameOf(line: string): WorkerFrame {
  const frame = recordOf(line);
  if (typeof frame.out === "string") return { out: frame.out };
  if (typeof frame.err === "string") return { err: frame.err };
  if (typeof frame.progress === "string") return { progress: frame.progress };
  if (typeof frame.note === "string") return { note: frame.note };
  if (isRecord(frame.ask)) return askOf(frame.ask);
  if (frame.stdin === true) return { stdin: true };
  if ("line" in frame) return { line: stringsOf(frame.line, "line") };
  if ("result" in frame) return { result: outcomeOf(frame.result) };
  throw new BadWorkerFrame("незнакомый кадр исполнителя");
}
