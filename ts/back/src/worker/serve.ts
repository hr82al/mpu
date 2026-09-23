/**
 * Сторона исполнителя (`platform/line-executor.md`): одна строка на
 * процесс. Кадр `run` → команда из реестра исполняется с портом, чьи
 * вопросы, ввод и вывод уходят кадрами ядру, → кадр `result`. Состояния
 * между строками нет: следующая строка — следующий процесс.
 */

import {
  type Answer,
  type CommandIo,
  DomainError,
  formatCommandError,
  type Prompt,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import {
  callContextOf,
  inputOnRequest,
  type LineInput,
} from "../frames/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { callIo } from "./callio.ts";
import {
  type AskKind,
  BadWorkerFrame,
  encode,
  type HostFrame,
  hostFrameOf,
  type Order,
  type Outcome,
  type WorkerFrame,
} from "./frames.ts";
import type { Wire } from "./wire.ts";

/** Ожидание ответа ядра: ответ пришёл либо ждать его больше нечего. */
interface Reply<T> {
  settle(value: T): void;
  fail(err: Error): void;
}

/** Вопроса нет: ответ, пришедший без него, игнорируется. */
const NO_REPLY: Reply<never> = { settle() {}, fail() {} };

/** Ядро ушло, пока исполнитель ждал ввод: ждать больше нечего. */
class HostGone extends Error {
  override name = "HostGone";
}

/**
 * Разговор исполнителя с ядром на одну строку: вопросы, ввод и
 * остановка. Ответы приходят кадрами, пока исполняется команда.
 */
class Conversation {
  readonly #wire: Wire;
  readonly #diagnose: (line: string) => void;
  readonly #stopping = new AbortController();
  #answer: Reply<string | null> = NO_REPLY;
  #input: Reply<Uint8Array> = NO_REPLY;
  #bytes: Promise<Uint8Array> | undefined;

  /** @param diagnose строка диагностики исполнителя (его stderr) */
  constructor(wire: Wire, diagnose: (line: string) => void) {
    this.#wire = wire;
    this.#diagnose = diagnose;
  }

  /** Просьба остановиться: кадр `stop` или конец провода. */
  signal(): AbortSignal {
    return this.#stopping.signal;
  }

  send(frame: WorkerFrame): Promise<void> {
    return this.#wire.send(encode(frame));
  }

  /** Вопрос ядру; `null` — спросить некого. */
  async ask(kind: AskKind, text: string): Promise<string | null> {
    const reply = Promise.withResolvers<string | null>();
    this.#answer = this.#awaited(reply, () => this.#answer = NO_REPLY);
    await this.send({ ask: { kind, text } });
    return await reply.promise;
  }

  /** Ввод строки: один запрос ядру, дальше — то же значение. */
  input(): LineInput {
    return {
      bytes: async () => (await (this.#bytes ??= this.#requested())).slice(),
    };
  }

  async #requested(): Promise<Uint8Array> {
    const reply = Promise.withResolvers<Uint8Array>();
    this.#input = this.#awaited(reply, () => this.#input = NO_REPLY);
    await this.send({ stdin: true });
    return await reply.promise;
  }

  /** Ожидание одного ответа: пришёл — ожидание снято. */
  #awaited<T>(
    reply: PromiseWithResolvers<T>,
    done: () => void,
  ): Reply<T> {
    return {
      settle: (value) => {
        done();
        reply.resolve(value);
      },
      fail: (err) => {
        done();
        reply.reject(err);
      },
    };
  }

  /** Кадр ядра; непонятый — строка диагностики, строка идёт дальше. */
  #frameOf(line: string): HostFrame | undefined {
    try {
      return hostFrameOf(line);
    } catch (err) {
      if (!(err instanceof BadWorkerFrame)) throw err;
      this.#diagnose(`mpu-worker: непонятый кадр ядра: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Кадры ядра после `run` — до конца провода. Конец провода — ядро
   * ушло: команда останавливается, ожидания снимаются.
   */
  async listen(lines: AsyncIterator<string>) {
    for (;;) {
      const next = await lines.next();
      if (next.done === true) break;
      const frame = this.#frameOf(next.value);
      if (frame === undefined) continue;
      if ("answer" in frame) this.#answer.settle(frame.answer);
      if ("stdin" in frame) {
        this.#input.settle(new TextEncoder().encode(frame.stdin));
      }
      if ("stop" in frame) this.#stopping.abort();
    }
    this.#stopping.abort();
    this.#answer.settle(null);
    this.#input.fail(new HostGone("ядро закрыло канал до ввода"));
  }
}

/** Вопрос человеку через ядро; ответ разбирает спросивший. */
function framePrompt(conversation: Conversation): Prompt {
  const asked = async <T>(
    kind: AskKind,
    question: string,
    answer: Answer<T>,
  ) => {
    const text = await conversation.ask(kind, question);
    return text === null ? await answer.absent() : await answer.given(text);
  };
  return {
    line: (question, answer) => asked("line", question, answer),
    secret: (question, answer) => asked("secret", question, answer),
    copy: async (text) => void (await conversation.ask("copy", text)),
  };
}

/** Вывод удалённой команды — кадрами, UTF-8 по кускам. */
function frameOutput(conversation: Conversation): RemoteOutput {
  const out = new TextDecoder();
  const err = new TextDecoder();
  const sent = (text: string, frame: WorkerFrame) =>
    text === "" ? Promise.resolve() : conversation.send(frame);
  return {
    out: (chunk) => {
      const text = out.decode(chunk, { stream: true });
      return sent(text, { out: text });
    },
    err: (chunk) => {
      const text = err.decode(chunk, { stream: true });
      return sent(text, { err: text });
    },
    captured: () => "",
  };
}

/**
 * Порт команды у исполнителя: порт процесса с контекстом вызова, а
 * вопросы, ввод, вывод, ход и заметки — кадрами ядру.
 *
 * @throws BadFrame — поля контекста непринимаемы (ядро их не пропустило бы)
 */
function orderIo(
  io: CommandIo,
  order: Order,
  conversation: Conversation,
): CommandIo {
  const context = callContextOf(
    { ...order.context },
    inputOnRequest(conversation.input()),
  );
  // Кадры хода и заметки отдаются без ожидания: порт синхронный, а
  // порядок держит сам провод.
  const post = (frame: WorkerFrame) => {
    conversation.send(frame).catch(() => {
      // Провод оборван — ядро ушло; сказать об этом некому, команду
      // остановит конец провода.
    });
  };
  return {
    ...callIo(io, context, order.cwd),
    signal: conversation.signal(),
    prompt: framePrompt(conversation),
    openRemoteOutput: () => frameOutput(conversation),
    progress: (line) => post({ progress: line }),
    note: (line) => post({ note: line }),
  };
}

/** Исход команды: значение, отказ её текстом с кодом или падение. */
async function outcomeOf(order: Order, io: CommandIo): Promise<Outcome> {
  const command = findCommand(order.path);
  if (command === undefined) {
    return { crash: `исполнителю неизвестна команда ${order.path.join(" ")}` };
  }
  try {
    return { value: await command.invoke(order.args, io) };
  } catch (err) {
    // Тот же перевод, что у точки входа: текст — здесь, где ошибка
    // ещё своего класса; ядру уходит готовая строка и код.
    if (err instanceof UsageError) {
      return { code: 2, stderr: formatCommandError(command.errorName, err) };
    }
    if (err instanceof DomainError) {
      return { code: 1, stderr: formatCommandError(command.errorName, err) };
    }
    return { crash: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Исполняет одну строку, пришедшую проводом, и возвращается, когда
 * ядро закрыло провод. Провод закрыт до `run` — строки не было.
 *
 * @param wire провод к ядру
 * @param io порт процесса исполнителя
 * @param diagnose строка диагностики исполнителя (его stderr)
 */
export async function serveOne(
  wire: Wire,
  io: CommandIo,
  diagnose: (line: string) => void,
): Promise<void> {
  const lines = wire.lines()[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    if (first.done === true) return;
    const frame = hostFrameOf(first.value);
    if (!("run" in frame)) throw new Error("первый кадр ядра — не run");
    const conversation = new Conversation(wire, diagnose);
    const listening = conversation.listen(lines);
    const outcome = outcomeOf(frame.run, orderIo(io, frame.run, conversation));
    // Ядро ушло — итог отдавать некому, и ждать команду, не слушающую
    // остановку, незачем: процесс исполнителя кончается сразу
    // (`platform/line-executor.md`, «ядро перезапустилось»).
    const finished = await Promise.race([outcome, listening]);
    if (finished === undefined) return;
    await conversation.send({ result: finished });
    await wire.close();
    await listening;
  } finally {
    // Конец вывода ядро видит и тогда, когда строки не было или
    // исполнение сорвалось: иначе оно ждало бы его вечно.
    await wire.close();
  }
}
