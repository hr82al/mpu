/**
 * Один дочерний супервизора (`platform/supervisor-install.md`,
 * «Супервизор»): свой процесс, счёт падений подряд и момент старта. Сам
 * решает, что делать, когда процесс кончился: пауза и перезапуск после
 * падения, сразу запуск после перезапуска по сигналу, конец при остановке.
 */

/** Часы супервизора: время и пауза с отменой. */
export interface Clock {
  now(): number;
  /** Пауза `ms`; `signal` прерывает её раньше. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Запущенный процесс. */
export interface Process {
  readonly pid: number;
  /** Завершается, когда процесс кончился (код не важен). */
  readonly exited: Promise<void>;
  kill(signal: Deno.Signal): void;
}

/** Как запускается процесс. */
export interface Launcher {
  /**
   * Запускает `command args`; вывод — построчно в `line`.
   *
   * @throws когда процесс не запустился (нет файла, нет прав)
   */
  spawn(
    command: string,
    args: readonly string[],
    line: (stream: "out" | "err", text: string) => void,
  ): Process;
}

/** Куда пишет супервизор: свои строки и строки дочерних. */
export interface Log {
  out(text: string): void;
  err(text: string): void;
}

/** Первая пауза и потолок: 1, 2, 4, 8, 16, 30, 30… секунд. */
const FIRST_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 30_000;
/** Проработал столько — счёт пауз сначала. */
const STEADY_MS = 60_000;
/** Сколько ждать конца после `SIGTERM`, дальше — `SIGKILL`. */
export const KILL_AFTER_MS = 10_000;

/** Процесса нет: до запуска и в паузе. */
const NO_PROCESS: Process = {
  pid: 0,
  exited: Promise.resolve(),
  kill() {},
};

/** Что дочерний делает, когда его процесс кончился. */
interface Intent {
  /** @returns продолжать ли цикл */
  after(child: Child, ranMs: number): Promise<boolean>;
}

/** Процесс кончился сам: пауза по счёту падений и снова запуск. */
const CRASH: Intent = {
  after: (child, ranMs) => child.pause(ranMs),
};

/** Перезапуск по сигналу: сразу запуск, это не падение. */
const RESTART: Intent = {
  after: () => Promise.resolve(true),
};

/** Остановка супервизора: цикл кончен. */
const STOP: Intent = {
  after: () => Promise.resolve(false),
};

/** Дочерний: запуск, ожидание, решение после конца — по кругу. */
export class Child {
  readonly #name: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #launcher: Launcher;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #stopping = new AbortController();
  #process: Process = NO_PROCESS;
  #intent: Intent = CRASH;
  /** Прерывает текущую паузу: перезапуск по сигналу не ждёт её конца. */
  #wake = new AbortController();
  #crashes = 0;
  #running: Promise<void> = Promise.resolve();

  constructor(parts: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly launcher: Launcher;
    readonly clock: Clock;
    readonly log: Log;
  }) {
    this.#name = parts.name;
    this.#command = parts.command;
    this.#args = parts.args;
    this.#launcher = parts.launcher;
    this.#clock = parts.clock;
    this.#log = parts.log;
  }

  /** PID текущего процесса; процесса нет — 0. */
  pid(): number {
    return this.#process.pid;
  }

  /** Запускает цикл дочернего. */
  start() {
    this.#running = this.#loop();
  }

  /** Перезапуск: `SIGTERM` (и `SIGKILL` через 10 с), затем сразу запуск. */
  async restart() {
    this.#intent = RESTART;
    this.#wake.abort();
    await this.#terminate();
  }

  /** Остановка: процесс гасится, цикл кончается. */
  async stop() {
    this.#intent = STOP;
    this.#stopping.abort();
    await this.#terminate();
    await this.#running;
  }

  /** Пауза после падения; `false` — остановка пришла во время паузы. */
  async pause(ranMs: number): Promise<boolean> {
    this.#crashes = ranMs >= STEADY_MS ? 1 : this.#crashes + 1;
    const ms = Math.min(
      FIRST_PAUSE_MS * 2 ** (this.#crashes - 1),
      MAX_PAUSE_MS,
    );
    this.#log.err(
      `[supervisor] ${this.#name}: перезапуск через ${ms / 1000} с`,
    );
    this.#wake = new AbortController();
    await this.#clock.sleep(
      ms,
      AbortSignal.any([this.#stopping.signal, this.#wake.signal]),
    );
    return !this.#stopping.signal.aborted;
  }

  async #loop() {
    while (!this.#stopping.signal.aborted) {
      // Намерение — на этот запуск: перезапуск, пришедший в паузе, уже
      // исполнен самим запуском.
      this.#intent = CRASH;
      const started = this.#clock.now();
      await this.#once();
      const intent = this.#intent;
      if (!(await intent.after(this, this.#clock.now() - started))) return;
    }
  }

  /** Один запуск процесса до его конца. */
  async #once() {
    try {
      this.#process = this.#launcher.spawn(
        this.#command,
        this.#args,
        (stream, text) => this.#line(stream, text),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#log.err(`[supervisor] ${this.#name}: не запустился: ${reason}`);
      return;
    }
    this.#log.out(
      `[supervisor] ${this.#name}: запущен, pid ${this.#process.pid}`,
    );
    await this.#process.exited;
    this.#process = NO_PROCESS;
  }

  #line(stream: "out" | "err", text: string) {
    const line = `[${this.#name}] ${text}`;
    if (stream === "out") this.#log.out(line);
    else this.#log.err(line);
  }

  /** `SIGTERM`; не кончился за 10 с — `SIGKILL`. */
  async #terminate() {
    const process = this.#process;
    process.kill("SIGTERM");
    const late = new AbortController();
    const exited = process.exited.then(() => late.abort());
    await this.#clock.sleep(KILL_AFTER_MS, late.signal);
    if (!late.signal.aborted) {
      this.#log.err(
        `[supervisor] ${this.#name}: не ответил на SIGTERM, SIGKILL`,
      );
      process.kill("SIGKILL");
    }
    await exited;
  }
}
