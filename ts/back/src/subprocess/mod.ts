/**
 * Подпроцесс поверх `node:child_process`, одинаковый под Bun, Deno и Node
 * (`platform/node-runtime.md`, [S.9a]). Различия рантаймов живут как раз
 * здесь: отказ запуска приходит событием, а не броском, поток вывода
 * не запустившегося процесса под Node кончается, а под Bun и Deno
 * обрывается (проба 2026-10-07), выход по сигналу — `null` вместо кода.
 * Модуль прячет их: отказ запуска — отвергнутый промис с кодом ОС до
 * первого обращения к потокам, код по сигналу — `128 + номер`, как у
 * оболочки, потоки — веб-потоки, как у всего кода `back/`.
 */

import {
  type ChildProcess,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import process from "node:process";
import { Readable, Writable } from "node:stream";

/** Куда подключён поток процесса. */
export type Stdio = "null" | "piped" | "inherit";

/** Как запускать. */
export interface ProgramOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Переменные сверх унаследованного окружения. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Только `env`: окружение родителя не наследуется. */
  readonly clearEnv?: boolean;
  /** По умолчанию — `null`. */
  readonly stdin?: Stdio;
  /** По умолчанию — `piped`. */
  readonly stdout?: Stdio;
  /** По умолчанию — `piped`. */
  readonly stderr?: Stdio;
  /**
   * Отмена: процесс получает `SIGTERM`, а исход — его статус, не отказ.
   * Срок вышел — то же самое: вызывающий узнаёт его по `signal`.
   */
  readonly signal?: AbortSignal;
}

/** Чем кончился процесс. */
export interface ProgramStatus {
  readonly success: boolean;
  /** Код выхода; по сигналу — `128 + номер`, как у оболочки. */
  readonly code: number;
  /** Сигнал, которым процесс снят; вышел сам — `null`. */
  readonly signal: NodeJS.Signals | null;
}

/** Статус и всё, что процесс написал в подключённые потоки. */
export interface ProgramOutput extends ProgramStatus {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Пустой поток: им отвечает неподключённый (`null`/`inherit`). */
function emptyReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

/** Пустой приёмник: в неподключённый stdin писать некуда. */
function closedWritable(): WritableStream<Uint8Array> {
  return new WritableStream({
    start: (controller) =>
      controller.error(new Error("stdin процесса не подключён")),
  });
}

/** Код выхода по сигналу — `128 + номер`, как у оболочки. */
function statusOf(
  code: number | null,
  signal: NodeJS.Signals | null,
): ProgramStatus {
  if (signal === null) {
    return { success: code === 0, code: code ?? 1, signal: null };
  }
  return { success: false, code: 128 + constants.signals[signal], signal };
}

/** Всё содержимое потока. */
async function drained(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

/** Запущенный процесс: потоки, статус, сигнал. */
export class Program {
  readonly pid: number;
  /** stdin; не подключён (`null`) — запись отвергается. */
  readonly stdin: WritableStream<Uint8Array>;
  /** stdout; не подключён — пустой поток. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** stderr; не подключён — пустой поток. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Конец процесса; дожидаться обязан каждый, кто запустил. */
  readonly status: Promise<ProgramStatus>;
  readonly #child: ChildProcess;

  /**
   * Процесс, уже порождённый `spawn`. Отказа запуска здесь не ждут:
   * его сообщит `status`. Нужен тому, у кого запуск синхронен по
   * контракту и программа заведомо есть (`/bin/sh`); прочим —
   * `startProgram`.
   *
   * @param signal отмена: `SIGTERM` процессу
   */
  constructor(child: ChildProcess, signal?: AbortSignal) {
    this.#child = child;
    this.pid = child.pid ?? 0;
    this.stdin =
      child.stdin === null ? closedWritable() : Writable.toWeb(child.stdin);
    this.stdout =
      child.stdout === null
        ? emptyReadable()
        : (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.stderr =
      child.stderr === null
        ? emptyReadable()
        : (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>);
    this.status = this.#ended(signal);
  }

  async #ended(signal: AbortSignal | undefined): Promise<ProgramStatus> {
    const child = this.#child;
    const cancel = () => this.kill("SIGTERM");
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Событие `exit`, а не `close`: `close` ждёт конца потоков, а их
      // вызывающий может и не читать — статус не должен от этого зависеть.
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }
      return statusOf(child.exitCode, child.signalCode);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  /** Сигнал процессу; кончившийся процесс сигнал не получает и не бросает. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.#child.kill(signal);
  }

  /** Статус и весь вывод; stdin закрывается — ввода больше не будет. */
  async output(): Promise<ProgramOutput> {
    const [stdout, stderr, status] = await Promise.all([
      drained(this.stdout),
      drained(this.stderr),
      this.status,
    ]);
    return { ...status, stdout, stderr };
  }
}

/** Подключение трёх потоков для `spawn`. */
function stdioOf(options: ProgramOptions): StdioOptions {
  const mode = (stdio: Stdio) =>
    stdio === "null" ? "ignore" : stdio === "piped" ? "pipe" : "inherit";
  return [
    mode(options.stdin ?? "null"),
    mode(options.stdout ?? "piped"),
    mode(options.stderr ?? "piped"),
  ];
}

/**
 * Запуск программы. Разрешается, когда процесс запущен; отказ запуска
 * (`ENOENT` — программы нет, `EACCES` — не исполняемая) — отвергнутый
 * промис с ошибкой ОС, до первого обращения к потокам.
 */
export async function startProgram(
  bin: string,
  options: ProgramOptions,
): Promise<Program> {
  const child = spawn(bin, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.clearEnv
      ? { ...options.env }
      : { ...process.env, ...options.env },
    stdio: stdioOf(options),
  });
  await once(child, "spawn");
  return new Program(child, options.signal);
}

/** Запуск до конца: статус и вывод подключённых потоков. */
export async function runProgram(
  bin: string,
  options: ProgramOptions,
): Promise<ProgramOutput> {
  const program = await startProgram(bin, options);
  // Ввод, если подключён, закрывается сразу: дождаться конца процесса,
  // который ждёт ввода, иначе нельзя.
  if (options.stdin === "piped") await program.stdin.close();
  return await program.output();
}
