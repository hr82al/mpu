/**
 * Пул исполнителей ядра (`platform/line-executor.md`, «Пул и протокол»):
 * тёплые простаивающие исполнители, долив сразу после выдачи и предел
 * занятых. Строка берёт исполнителя, исполняет на нём ровно одну команду
 * и отпускает его умирать — память возвращается вместе с процессом.
 */

import type { Command, CommandIo } from "../command/mod.ts";
import type { InvokeJournal, Invoker, Output } from "../entrypoint/mod.ts";
import type { Evaluator } from "../line/mod.ts";
import type { LineReply, ProgramEnd } from "../program/mod.ts";
import { unlaunched } from "./death.ts";
import type { Launcher } from "./launch.ts";
import { LineWorker, type WorkerParts } from "./lineworker.ts";

/** Сколько простаивающих держать, если не сказано иное. */
export const DEFAULT_WARM = 2;

/** Что нужно пулу. */
export interface PoolParts extends WorkerParts {
  readonly launcher: Launcher;
  /** Сколько простаивающих держать запущенными. */
  readonly warm: number;
  /** Больше скольких занятых не бывает: предел одновременных строк. */
  readonly limit: number;
}

/** Строка, ждущая свободного места под исполнителя. */
interface Turn {
  go(): void;
}

/** Пул исполнителей: выдаёт исполнителя строке и доливает простаивающих. */
export class Workers implements Invoker, Evaluator {
  readonly #parts: PoolParts;
  readonly #idle: LineWorker[] = [];
  readonly #living = new Set<LineWorker>();
  readonly #turns: Turn[] = [];
  #busy = 0;

  constructor(parts: PoolParts) {
    this.#parts = parts;
  }

  /** Запустить простаивающих. */
  start() {
    this.#fill();
  }

  /** Сколько простаивающих сейчас (`platform/line-executor.md`, сценарий 2). */
  idle(): number {
    return this.#idle.length;
  }

  /** Сколько исполнителей заняты строками и ещё не кончились. */
  busy(): number {
    return this.#busy;
  }

  /**
   * Исполняет команду на исполнителе из пула. Места нет — ждёт, пока
   * кончится занятый; отмена строки снимает ожидание.
   */
  async invoke(
    command: Command,
    args: readonly string[],
    io: CommandIo,
    journal: InvokeJournal | undefined,
  ): Promise<unknown> {
    await this.#turn(io.signal);
    const worker = this.#take();
    return await worker.run(command, args, io, journal);
  }

  /**
   * Исполняет программу на исполнителе вне предела занятых
   * (`platform/evaluator.md`, «Где исполняется»): её команды сами займут
   * места — иначе при пределе 1 программа ждала бы места, занятого ею
   * же.
   *
   * @throws VerbatimError — исполнитель не запустился
   */
  async evaluate(
    words: readonly string[],
    io: CommandIo,
    output: Output,
    core: (words: readonly string[]) => Promise<LineReply>,
    journal: InvokeJournal,
  ): Promise<ProgramEnd> {
    const worker = this.#outside();
    return await worker.evaluate(words, io, output, core, journal);
  }

  /** Остановка ядра: простаивающим — конец stdin, занятым — `stop`. */
  async stop() {
    for (const worker of this.#idle.splice(0)) await worker.close();
    for (const worker of this.#living) worker.stop();
    await Promise.all([...this.#living].map((worker) => worker.exited()));
  }

  /** Место под исполнителя: сразу, если занятых меньше предела. */
  #turn(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#busy < this.#parts.limit) {
      this.#busy++;
      return Promise.resolve();
    }
    const turn = Promise.withResolvers<void>();
    const waiting: Turn = {
      go: () => {
        signal.removeEventListener("abort", cancel);
        this.#busy++;
        turn.resolve();
      },
    };
    const cancel = () => {
      this.#turns.splice(this.#turns.indexOf(waiting), 1);
      turn.reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    this.#turns.push(waiting);
    return turn.promise;
  }

  /**
   * Исполнитель под занятое место: простаивающий либо новый; пул
   * доливается сразу. Место отпускается, когда исполнитель кончился.
   *
   * @throws VerbatimError — исполнитель не запустился
   */
  #take(): LineWorker {
    let worker: LineWorker;
    try {
      worker = this.#idle.shift() ?? this.#launched();
    } catch (err) {
      this.#release();
      throw unlaunched(err);
    }
    this.#fill();
    worker.exited().then(() => this.#release());
    return worker;
  }

  /** Исполнитель мимо предела: простаивающий либо новый; долив — сразу. */
  #outside(): LineWorker {
    let worker: LineWorker;
    try {
      worker = this.#idle.shift() ?? this.#launched();
    } catch (err) {
      throw unlaunched(err);
    }
    this.#fill();
    return worker;
  }

  #release() {
    this.#busy--;
    this.#turns.shift()?.go();
  }

  /** Долив простаивающих; не запускается — одна строка диагностики. */
  #fill() {
    while (this.#idle.length < this.#parts.warm) {
      let worker: LineWorker;
      try {
        worker = this.#launched();
      } catch (err) {
        this.#parts.diagnose(`${unlaunched(err).message}`);
        return;
      }
      this.#idle.push(worker);
      // Простаивающий умер сам (убит, не нашёл программу): из пула он
      // уходит, а доливается пул только выдачей — иначе программа,
      // падающая на старте, запускалась бы по кругу.
      worker.exited().then(() => {
        const at = this.#idle.indexOf(worker);
        if (at >= 0) this.#idle.splice(at, 1);
      });
    }
  }

  #launched(): LineWorker {
    const worker = new LineWorker(this.#parts.launcher.launch(), this.#parts);
    this.#living.add(worker);
    worker.exited().then(() => this.#living.delete(worker));
    return worker;
  }
}
