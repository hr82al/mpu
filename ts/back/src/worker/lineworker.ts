/**
 * Исполнитель строки глазами ядра (`platform/line-executor.md`): один
 * запущенный процесс, одна строка. Ядро шлёт ему `run`, отвечает на его
 * вопросы и запросы ввода своими портами, передаёт его вывод строке и
 * получает исход. Что значит конец его вывода без результата, решает он
 * сам: остановило ли его ядро, убил ли сторож, упал ли он.
 */

import {
  type Command,
  type CommandIo,
  type RemoteOutput,
  VerbatimError,
  VerbatimUsageError,
} from "../command/mod.ts";
import type { InvokeJournal, Output } from "../entrypoint/mod.ts";
import { contextFieldsOf } from "../frames/mod.ts";
import type { LineReply, ProgramEnd } from "../program/mod.ts";
import { deathOf, type ExitStatus, type Markers } from "./death.ts";
import {
  BadWorkerFrame,
  encode,
  type HostFrame,
  type Order,
  type Outcome,
  type WorkerFrame,
  workerFrameOf,
} from "./frames.ts";
import type { Spawned } from "./launch.ts";

/** Сколько ждать исполнителя после `stop`, затем после `SIGTERM`. */
export const STOP_GRACE_MS = 5_000;

/** Строку остановило ядро, а исполнитель кончился, не дождавшись итога. */
export class WorkerStopped extends Error {
  override name = "WorkerStopped";
}

/** Что исполнителю нужно от ядра, кроме запущенного процесса. */
export interface WorkerParts {
  readonly markers: Markers;
  /** Диагностика ядра: чужая печать исполнителя в его stdout. */
  readonly diagnose: (line: string) => void;
}

/** Как читается конец вывода без результата. */
interface Ending {
  error(worker: LineWorker, status: ExitStatus): Promise<Error>;
}

/** Исполнитель кончился сам: смерть читает отметку сторожа. */
const OWN_END: Ending = {
  error: (worker, status) => worker.death(status),
};

/** Исполнителя остановило ядро: исход строки — её остановка. */
const STOPPED_END: Ending = {
  error: () =>
    Promise.resolve(new WorkerStopped("исполнитель строки остановлен")),
};

/** Приказ исполнителю: команда, аргументы и контекст с порта строки. */
function orderOf(
  command: Command,
  args: readonly string[],
  io: CommandIo,
): Order {
  const context: Record<string, unknown> = {
    ...contextFieldsOf({
      // Ввод здесь не читается: его исполнитель попросит кадром.
      stdin: () => Promise.resolve(""),
      stdinIsTerminal: () => io.stdinIsTerminal(),
      stdoutIsTerminal: () => io.stdoutIsTerminal(),
      stderrIsTerminal: () => io.stderrIsTerminal(),
      columns: () => io.consoleColumns(),
      value: (name) => io.env(name),
    }),
    stdinOnRequest: true,
  };
  return { path: command.path, args, cwd: io.cwd(), context };
}

/** Строка команды программы — ядру; у команды таких строк нет. */
type Core = (words: readonly string[]) => Promise<LineReply>;

/** Исполнитель команды строк ядру не шлёт: такая строка — отказ. */
const NO_CORE: Core = () => Promise.resolve({ exit: 1 });

/** Куда идёт вывод исполнителя: команды — её удалённый вывод, программы — строка. */
interface Sink {
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
}

/** Вывод программы — в вывод строки: его перехватывает журнал. */
function lineSink(output: Output): Sink {
  return {
    out: (text) => Promise.resolve(output.stdout(text)),
    err: (text) => Promise.resolve(output.stderr(text)),
  };
}

/** Исход исполнителя — значение или брошенный отказ того же класса. */
function valueOf(outcome: Outcome): unknown {
  if ("value" in outcome) return outcome.value;
  if ("crash" in outcome) throw new Error(outcome.crash);
  if ("exit" in outcome) {
    throw new Error("исполнитель команды отдал итог программы");
  }
  // Текст уже собран исполнителем: печатается дословно, код — его.
  if (outcome.code === 2) throw new VerbatimUsageError(outcome.stderr);
  throw new VerbatimError(outcome.stderr);
}

/** Один процесс-исполнитель. */
export class LineWorker {
  readonly #spawned: Spawned;
  readonly #parts: WorkerParts;
  readonly #lines: AsyncIterator<string>;
  readonly #over = new AbortController();
  readonly #exited: Promise<void>;
  #ending: Ending = OWN_END;
  /** Дочитывание вывода после конца строки: поток не бросается открытым. */
  #drained: Promise<void> = Promise.resolve();

  constructor(spawned: Spawned, parts: WorkerParts) {
    this.#spawned = spawned;
    this.#parts = parts;
    this.#lines = spawned.wire.lines()[Symbol.asyncIterator]();
    this.#exited = spawned.status.then(() => this.#over.abort());
  }

  pid(): number {
    return this.#spawned.pid;
  }

  /** Процесс кончился, его вывод дочитан. */
  async exited(): Promise<void> {
    await this.#exited;
    await this.#drained;
  }

  /**
   * Исполняет команду и отдаёт её результат.
   *
   * @throws отказ команды тем же классом, что бросила бы она сама;
   *   смерть исполнителя — `VerbatimError` с её текстом; остановленный
   *   ядром — `WorkerStopped`
   */
  async run(
    command: Command,
    args: readonly string[],
    io: CommandIo,
    journal: InvokeJournal | undefined,
  ): Promise<unknown> {
    journal?.executedBy(this.pid());
    const stop = () => this.stop();
    io.signal.addEventListener("abort", stop, { once: true });
    try {
      await this.#send({ run: orderOf(command, args, io) });
      // Остановку, пришедшую до подписки, слушатель не услышит.
      if (io.signal.aborted) this.stop();
      return valueOf(await this.#converse(io, new LazyRemote(io), NO_CORE));
    } finally {
      io.signal.removeEventListener("abort", stop);
      await this.close();
    }
  }

  /**
   * Исполняет программу (`platform/evaluator.md`): её печать — в
   * `output`, её команды — `core` отдельными строками.
   *
   * @throws смерть исполнителя — `VerbatimError` с её текстом;
   *   остановленный ядром без итога — `WorkerStopped`
   */
  async evaluate(
    words: readonly string[],
    io: CommandIo,
    output: Output,
    core: Core,
    journal: InvokeJournal,
  ): Promise<ProgramEnd> {
    journal.executedBy(this.pid());
    const stop = () => this.stop();
    io.signal.addEventListener("abort", stop, { once: true });
    try {
      await this.#send({ evaluate: { words } });
      if (io.signal.aborted) this.stop();
      return endOf(await this.#converse(io, lineSink(output), core));
    } finally {
      io.signal.removeEventListener("abort", stop);
      await this.close();
    }
  }

  /**
   * Строк больше не будет: исполнитель увидит конец stdin и кончится;
   * его оставшийся вывод дочитывается.
   */
  async close(): Promise<void> {
    await this.#spawned.wire.close();
    this.#drained = this.#drain().catch((err) =>
      this.#parts.diagnose(`[worker ${this.pid()}] вывод не дочитан: ${err}`)
    );
  }

  /**
   * Вывод после конца строки: кадры (поздний итог строки, сорванной
   * ядром) уже никому не нужны, чужая печать — диагностика.
   */
  async #drain() {
    for (;;) {
      const next = await this.#lines.next();
      if (next.done === true) return;
      this.#frameOf(next.value);
    }
  }

  /**
   * Остановить: кадр `stop`; не кончился за `STOP_GRACE_MS` — `SIGTERM`,
   * ещё через столько же — `SIGKILL`.
   */
  stop() {
    if (this.#ending === STOPPED_END) return;
    this.#ending = STOPPED_END;
    this.#send({ stop: true }).catch(() => {
      // Исполнитель уже не читает: его остановят сигналы ниже.
    });
    this.#escalate().catch((err) =>
      this.#parts.diagnose(`mpu-back: исполнитель не остановлен: ${err}`)
    );
  }

  /** Ошибка строки по смерти исполнителя и отметке сторожа о нём. */
  async death(status: ExitStatus): Promise<Error> {
    const { markers } = this.#parts;
    const mark = await markers.take(this.pid(), this.#spawned.startedAt);
    return deathOf(status, mark);
  }

  async #escalate() {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (await this.#outlived(STOP_GRACE_MS)) return;
      this.#spawned.kill(signal);
    }
  }

  /** Кончился ли исполнитель за `ms`; ожидание снимается его концом. */
  #outlived(ms: number): Promise<boolean> {
    const over = this.#over.signal;
    if (over.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        over.removeEventListener("abort", done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      over.addEventListener("abort", done, { once: true });
    });
  }

  async #send(frame: HostFrame): Promise<void> {
    await this.#spawned.wire.send(encode(frame));
  }

  /** Кадры исполнителя до результата; конец без результата — смерть. */
  async #converse(io: CommandIo, sink: Sink, core: Core): Promise<Outcome> {
    for (;;) {
      const next = await this.#lines.next();
      if (next.done === true) break;
      const frame = this.#frameOf(next.value);
      if (frame === undefined) continue;
      if ("result" in frame) return frame.result;
      await this.#serve(frame, io, sink, core);
    }
    const status = await this.#spawned.status;
    throw await this.#ending.error(this, status);
  }

  /** Кадр строки; чужая печать в stdout — диагностика, не отказ. */
  #frameOf(line: string): WorkerFrame | undefined {
    try {
      return workerFrameOf(line);
    } catch (err) {
      if (!(err instanceof BadWorkerFrame)) throw err;
      this.#parts.diagnose(`[worker ${this.pid()}] ${line}`);
      return undefined;
    }
  }

  /** Кадр исполнителя — действие порта строки; вопрос и ввод — ответ. */
  async #serve(frame: WorkerFrame, io: CommandIo, sink: Sink, core: Core) {
    if ("out" in frame) return await sink.out(frame.out);
    if ("err" in frame) return await sink.err(frame.err);
    if ("line" in frame) {
      return await this.#unlessGone(
        core(frame.line).then((lined) => this.#send({ lined })),
      );
    }
    if ("progress" in frame) return io.progress(frame.progress);
    if ("note" in frame) return io.note(frame.note);
    if ("stdin" in frame) {
      return await this.#unlessGone(
        io.readStdin().then((bytes) =>
          this.#send({ stdin: new TextDecoder().decode(bytes) })
        ),
      );
    }
    if ("ask" in frame) {
      return await this.#unlessGone(
        answerOf(frame.ask, io).then((answer) => this.#send({ answer })),
      );
    }
  }

  /**
   * Ответ исполнителю, пока он жив. Человек думает, ввод едет — а
   * исполнителя уже убили: ждать дальше некому, и конец его вывода
   * должен читаться сразу, а не после ответа.
   */
  async #unlessGone(reply: Promise<void>): Promise<void> {
    // Отказ проигравшего ответа никому не нужен: строка кончается
    // смертью исполнителя. Отказ выигравшего доходит через `race`.
    reply.catch(() => {});
    await Promise.race([reply, this.#exited]);
  }
}

/** Итог программы из исхода исполнителя; прочий исход — сбой. */
function endOf(outcome: Outcome): ProgramEnd {
  if ("exit" in outcome) return outcome;
  if ("crash" in outcome) throw new Error(outcome.crash);
  throw new Error("исполнитель программы отдал итог команды");
}

/** Ответ человека на вопрос исполнителя; `null` — спросить некого. */
async function answerOf(
  ask: { readonly kind: "line" | "secret" | "copy"; readonly text: string },
  io: CommandIo,
): Promise<string | null> {
  const answer = {
    given: (text: string): string | null => text,
    absent: (): string | null => null,
  };
  switch (ask.kind) {
    case "line":
      return await io.prompt.line(ask.text, answer);
    case "secret":
      return await io.prompt.secret(ask.text, answer);
    case "copy":
      await io.prompt.copy(ask.text);
      return null;
  }
}

/**
 * Вывод удалённой команды строки: открывается при первом куске и один
 * на всю строку — сколько бы приёмников ни открыла команда у
 * исполнителя, кадры идут строке по порядку.
 */
class LazyRemote implements Sink {
  readonly #io: CommandIo;
  readonly #encoder = new TextEncoder();
  #remote: RemoteOutput | undefined;

  constructor(io: CommandIo) {
    this.#io = io;
  }

  out(text: string): Promise<void> {
    return this.#opened().out(this.#encoder.encode(text));
  }

  err(text: string): Promise<void> {
    return this.#opened().err(this.#encoder.encode(text));
  }

  #opened(): RemoteOutput {
    return this.#remote ??= this.#io.openRemoteOutput();
  }
}
