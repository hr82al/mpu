/**
 * Запуск исполнителя (`platform/line-executor.md`): отдельным процессом
 * с `oom_score_adj` = 1000 либо в памяти этого же процесса — тем же
 * исполнением строки и тем же кодеком кадров, только без процесса.
 */

import { spawn } from "node:child_process";
import type { CommandIo } from "../command/mod.ts";
import { Program } from "../subprocess/mod.ts";
import { type ExitStatus, killedStatus, type StopSignal } from "./death.ts";
import { serveOne } from "./serve.ts";
import { memoryWires, streamWire, type Wire } from "./wire.ts";

/** Запущенный исполнитель глазами ядра. */
export interface Spawned {
  readonly pid: number;
  /** Когда запущен, мс: отметка сторожа старше — не о нём. */
  readonly startedAt: number;
  /** Провод: stdin и stdout исполнителя. */
  readonly wire: Wire;
  /** Как кончился процесс. */
  readonly status: Promise<ExitStatus>;
  kill(signal: StopSignal): void;
}

/** Как запускается исполнитель. */
export interface Launcher {
  /** @throws Error — исполнитель не запустился */
  launch(): Spawned;
}

/**
 * Обёртка запуска: `oom_score_adj` ставит оболочка и `exec`-ом отдаёт
 * процесс исполнителю — значение наследуется. Оболочкой, а не записью
 * в `/proc/<pid>/oom_score_adj` после запуска: значение действует с
 * первой инструкции исполнителя, а не с момента, когда ядро успело его
 * записать.
 */
const OOM_WRAPPER = 'echo 1000 > /proc/self/oom_score_adj && exec "$0" "$@"';

/** Поток — построчно в `line`. */
async function eachLine(
  stream: ReadableStream<Uint8Array>,
  line: (text: string) => void,
): Promise<void> {
  // Декодер с `stream: true`, а не `TextDecoderStream` — как у провода
  // (`wire.ts`, `linesOf`).
  const decoder = new TextDecoder();
  let rest = "";
  for await (const bytes of stream) {
    const parts = (rest + decoder.decode(bytes, { stream: true })).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) line(part);
  }
  rest += decoder.decode();
  if (rest !== "") line(rest);
}

/** Что нужно запуску процесса исполнителя. */
export interface ProgramParts {
  /** Программа исполнителя (`mpu-worker`) и её аргументы. */
  readonly command: string;
  readonly args: readonly string[];
  /** Диагностика ядра: stderr исполнителя с префиксом `[worker <pid>] `. */
  readonly diagnose: (line: string) => void;
  readonly now: () => number;
}

/** Исполнитель — отдельный процесс под `/bin/sh`-обёрткой. */
export class ProcessLauncher implements Launcher {
  readonly #parts: ProgramParts;

  constructor(parts: ProgramParts) {
    this.#parts = parts;
  }

  launch(): Spawned {
    const { command, args, diagnose, now } = this.#parts;
    // Запуск синхронен по контракту пула, а `/bin/sh` есть всегда.
    // Отказ запуска, если он всё же случится, отвергнет `status` — как
    // отказ чтения провода: пул увидит исполнителя, который не дожил.
    const child = new Program(
      spawn("/bin/sh", ["-c", OOM_WRAPPER, command, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const pid = child.pid;
    // Сбой чтения stderr — строка диагностики, а не отказ статуса: конец
    // процесса ждут пул и остановка, и отвергнутый статус оставил бы их
    // без него.
    const errors = eachLine(child.stderr, (text) =>
      diagnose(`[worker ${pid}] ${text}`),
    ).catch((err) => diagnose(`[worker ${pid}] stderr не дочитан: ${err}`));
    return {
      pid,
      startedAt: now(),
      wire: streamWire(child.stdout, child.stdin),
      // Конец — когда кончились и процесс, и его stderr: строка,
      // пришедшая после выхода, не теряется.
      status: Promise.all([child.status, errors]).then(([status]) => ({
        code: status.code,
        signal: status.signal,
      })),
      // Кончившийся процесс сигнал не получает и не бросает.
      kill: (signal) => child.kill(signal),
    };
  }
}

/**
 * Исполнитель в памяти этого процесса: тот же `serveOne` на проводе в
 * памяти поверх порта `io`. Так весь путь строки — кадры, кодек, вопрос,
 * ввод — проверяется без порождения процессов.
 */
export class MemoryLauncher implements Launcher {
  readonly #io: CommandIo;
  readonly #now: () => number;
  #pid: number;
  readonly #launched: Spawned[] = [];

  /**
   * @param io порт, который получит исполняемая команда
   * @param firstPid номер первого исполнителя; следующие — по порядку
   * @param now часы: момент запуска исполнителя
   */
  constructor(io: CommandIo, firstPid: number, now: () => number) {
    this.#io = io;
    this.#pid = firstPid;
    this.#now = now;
  }

  /** Запущенные исполнители по порядку запуска. */
  launched(): readonly Spawned[] {
    return [...this.#launched];
  }

  launch(): Spawned {
    const { host, worker } = memoryWires();
    const killed = Promise.withResolvers<ExitStatus>();
    const served = serveOne(worker, this.#io, () => {}).then(
      (): ExitStatus => ({ code: 0, signal: null }),
      (): ExitStatus => ({ code: 1, signal: null }),
    );
    const spawned: Spawned = {
      pid: this.#pid++,
      startedAt: this.#now(),
      wire: host,
      // Убитый «процесс» доживает, пока его команда не заметит обрыв:
      // конец — когда кончилась и она, иначе задачу теста переживёт
      // висящее исполнение.
      status: Promise.race([served, killed.promise]).then(async (status) => {
        await served;
        return status;
      }),
      kill(signal) {
        // Убитый больше ничего не пишет и не читает: провод рвётся с
        // обеих сторон — ядро видит конец вывода без результата, команда
        // «процесса» — конец своего stdin.
        killed.resolve(killedStatus(signal));
        Promise.all([worker.close(), host.close()]).catch(() => {
          // Провод уже закрыт — рвать нечего.
        });
      },
    };
    this.#launched.push(spawned);
    return spawned;
  }
}
