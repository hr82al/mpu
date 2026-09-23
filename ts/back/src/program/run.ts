/**
 * Исполнение программы (`platform/evaluator.md`): разбор, машина, печать
 * последнего значения и итог — код и отказ-объект для ядра.
 */

import type { RefusalData } from "../frames/mod.ts";
import { dataOf, RefusalNotice, type Refused } from "../objects/mod.ts";
import { CommandResult, fromData } from "./data.ts";
import { Printed } from "./objects.ts";
import { Cancelled, Machine, type Pace, Place, Placed } from "./machine.ts";
import { type Commands, LENIENT_ROOT, parseProgram } from "./parse.ts";
import type { Reply } from "./protocol.ts";
import { Scope } from "./scope.ts";

/** Код отменённой строки. */
const CANCELLED = 130;

/** Код ошибки вычисления, включая отказ команды. */
const FAILED = 1;

/** Код отказа до исполнения. */
const REFUSED = 2;

/**
 * Ответ ядра на строку команды (граница кадра): данные результата,
 * команда, которая его дала (нет — данные без вида команды), и текст,
 * который строка напечатала бы, — либо код строки, не дошедшей до данных:
 * её отказ ядро уже сказало.
 */
export type LineReply =
  | {
    readonly data: unknown;
    readonly command: {
      readonly path: readonly string[];
      readonly argv: readonly string[];
    } | null;
    readonly shown: string;
  }
  | { readonly exit: number };

/** Итог программы (граница кадра): код и отказ-объект; нет отказа — `null`. */
export interface ProgramEnd {
  readonly exit: number;
  readonly refusal: RefusalData | null;
}

/** Что программе нужно снаружи. */
export interface ProgramPorts {
  readonly commands: Commands;
  /** Команда реестра — ядру отдельной строкой. */
  readonly core: (words: readonly string[]) => Promise<LineReply>;
  /** stdout строки. */
  readonly print: (text: string) => void;
  /** Отмена программы. */
  readonly signal: AbortSignal;
  readonly pace: Pace;
}

/** Подстрока кончилась кодом ≠ 0: её отказ уже сказан ядром. */
class LineExit extends Error {
  override name = "LineExit";
  readonly code: number;

  constructor(code: number) {
    super(`строка команды кончилась кодом ${code}`);
    this.code = code;
  }
}

/**
 * Отказ программы объектом (`platform/refusal-object.md`): текст — место
 * и отказ объекта, подсказка — слова программы с заменённым словом.
 *
 * @param words слова программы
 */
export function refusalOf(words: readonly string[], placed: Placed): Refused {
  const hint = placed.refusal.remedy.hint({
    address: "",
    taken: [],
    line: words,
    start: placed.span.start,
    end: placed.span.end,
  });
  return new RefusalNotice({
    reason: hint.reason(placed.refusal.reason),
    said: placed.message,
    hint,
    candidates: placed.refusal.candidates,
  });
}

/** Строка кончилась кодом ≠ 0: значения у неё нет. */
function exited(code: number): Reply {
  const end = () => {
    throw new LineExit(code);
  };
  return { value: end, printed: end };
}

/** Ответ ядра: результат команды, данные или конец строки. */
function replyOf(reply: LineReply, commands: Commands): Reply {
  if ("exit" in reply) return exited(reply.exit);
  const { data, command, shown } = reply;
  return {
    value: () =>
      command === null ? fromData(dataOf(data)) : new CommandResult(
        commands.view(command.path, data, command.argv),
        shown,
      ),
    printed: () => new Printed(shown),
  };
}

/** Ожидание `promise`, пока программу не отменили. */
function untilCancelled<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // Отказ проигравшего никому не нужен: программа кончается отменой.
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Cancelled("программа отменена"));
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", cancel)
    );
  });
}

/**
 * Код программы по коду её подстроки (граница кадра): отмена и отказ до
 * исполнения — как есть, прочий отказ — ошибка вычисления
 * (`platform/ask-composite.md`).
 */
function outward(code: number): number {
  if (code === CANCELLED || code === REFUSED) return code;
  return FAILED;
}

/** Итог по исключению исполнения; незнакомое — дальше. */
function ended(err: unknown, words: readonly string[]): ProgramEnd {
  if (err instanceof Cancelled) return { exit: CANCELLED, refusal: null };
  if (err instanceof LineExit) {
    return { exit: outward(err.code), refusal: null };
  }
  if (err instanceof Placed) {
    return { exit: FAILED, refusal: refusalOf(words, err).data() };
  }
  throw err;
}

/**
 * Исполняет программу: значение последнего выражения печатается видом по
 * умолчанию (`nil` — ничего). Сделанное до ошибки не откатывается.
 *
 * @param words слова программы; отказы до исполнения ядро уже проверило
 */
export async function runProgram(
  words: readonly string[],
  ports: ProgramPorts,
): Promise<ProgramEnd> {
  let program;
  try {
    program = parseProgram(words, ports.commands, LENIENT_ROOT);
  } catch (err) {
    if (!(err instanceof Placed)) throw err;
    return { exit: REFUSED, refusal: refusalOf(words, err).data() };
  }
  const place = new Place();
  const machine = new Machine({
    signal: ports.signal,
    pace: ports.pace,
    print: ports.print,
    core: async (line) =>
      replyOf(
        await untilCancelled(ports.core(line), ports.signal),
        ports.commands,
      ),
  }, place);
  try {
    const last = await machine.run(program.run(new Scope(), place));
    ports.print(last.shown());
    return { exit: 0, refusal: null };
  } catch (err) {
    return ended(err, words);
  }
}
