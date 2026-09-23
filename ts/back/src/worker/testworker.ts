/**
 * Исполнитель по сценарию для тестов ядра: тест сам играет сторону
 * исполнителя — читает кадры ядра, шлёт свои и решает, как «процесс»
 * кончится. Так проверяется разговор ядра с исполнителем без настоящей
 * команды и без процесса.
 */

import { type ExitStatus, killedStatus } from "./death.ts";
import {
  encode,
  type HostFrame,
  hostFrameOf,
  type WorkerFrame,
} from "./frames.ts";
import type { Launcher, Spawned } from "./launch.ts";
import { memoryWires } from "./wire.ts";

/** Сторона исполнителя в руках теста. */
export class ScriptedWorker {
  readonly spawned: Spawned;
  /** Сигналы, которые прислало ядро, по порядку. */
  readonly signals: Deno.Signal[] = [];
  readonly #lines: AsyncIterator<string>;
  readonly #send: (text: string) => Promise<void>;
  readonly #close: () => Promise<void>;
  readonly #status = Promise.withResolvers<ExitStatus>();
  readonly #stubborn: boolean;

  /**
   * @param pid номер «процесса»
   * @param options `stubborn` — на `SIGTERM` не умирает; `startedAt` —
   *   момент запуска
   */
  constructor(
    pid: number,
    options: { readonly stubborn?: boolean; readonly startedAt?: number } = {},
  ) {
    const { host, worker } = memoryWires();
    this.#lines = worker.lines()[Symbol.asyncIterator]();
    this.#send = (text) => worker.send(text);
    this.#close = () => worker.close();
    this.#stubborn = options.stubborn ?? false;
    this.spawned = {
      pid,
      startedAt: options.startedAt ?? Date.now(),
      wire: host,
      status: this.#status.promise,
      kill: (signal) => {
        this.signals.push(signal);
        if (signal === "SIGTERM" && this.#stubborn) return;
        this.end(killedStatus(signal)).catch(
          () => {
            // Провод уже закрыт сценарием — конец уже наступил.
          },
        );
      },
    };
  }

  /** Следующий кадр ядра; ядро закрыло провод — `undefined`. */
  async next(): Promise<HostFrame | undefined> {
    const next = await this.#lines.next();
    return next.done === true ? undefined : hostFrameOf(next.value);
  }

  send(frame: WorkerFrame): Promise<void> {
    return this.#send(encode(frame));
  }

  /** Строка в stdout, не кадр. */
  print(text: string): Promise<void> {
    return this.#send(`${text}\n`);
  }

  /** «Процесс» кончился: вывод закрыт, статус — `status`. */
  async end(status: ExitStatus): Promise<void> {
    await this.#close();
    this.#status.resolve(status);
  }
}

/** Запуск исполнителей по сценарию: каждый новый — следующий в очереди. */
export class ScriptedLauncher implements Launcher {
  readonly #queue: ScriptedWorker[];
  readonly launched: ScriptedWorker[] = [];

  constructor(workers: readonly ScriptedWorker[]) {
    this.#queue = [...workers];
  }

  launch(): Spawned {
    const worker = this.#queue.shift();
    if (worker === undefined) throw new Error("исполнителей в сценарии нет");
    this.launched.push(worker);
    return worker.spawned;
  }
}
