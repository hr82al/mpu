/**
 * Проверка миграций sl-N после `up` стека (`mp-init.md`, «Подъём с
 * нуля», шаг 4, миграции).
 *
 * Контейнер `<server>-migrations` завершается сам, и `up -d` отвечает 0,
 * даже если миграции упали, — поэтому код берётся у самого контейнера
 * (`docker wait`), а не у `up`.
 */

import type { Clock, Docker, ProcessOutcome } from "./docker.ts";

/** Срок ожидания завершения миграций. */
export const WAIT_LIMIT_MS = 10 * 60 * 1000;

/** Что нужно проверке: docker, часы, печать и рабочий каталог. */
export interface MigrationsContext {
  readonly docker: Docker;
  readonly clock: Clock;
  readonly progress: (line: string) => void;
  readonly cwd: string;
}

/** Проверка миграций стека; 0 — порядок, иначе код выхода команды. */
export interface Migrations {
  verify(context: MigrationsContext): Promise<number>;
}

/** Стек без миграций (nats, nginx, dt-host): проверять нечего. */
export const NO_MIGRATIONS: Migrations = {
  verify: () => Promise.resolve(0),
};

/** Исход ожидания контейнера миграций: сам решает, что печатать. */
interface WaitOutcome {
  report(context: MigrationsContext): Promise<number>;
}

/** Миграции сервера sl-N: контейнер `<server>-migrations`. */
export class ServerMigrations implements Migrations {
  constructor(private readonly server: string) {}

  async verify(context: MigrationsContext): Promise<number> {
    const outcome = await this.#waitFor(context);
    return await outcome.report(context);
  }

  /**
   * `docker wait` против срока. Проигравший вызов снимается сигналом и
   * всё равно дожидается: висящего процесса и таймера не остаётся.
   */
  async #waitFor(context: MigrationsContext): Promise<WaitOutcome> {
    const controller = new AbortController();
    const waiting = context.docker.probe(
      ["docker", "wait", `${this.server}-migrations`],
      context.cwd,
      controller.signal,
    );
    const timer = context.clock.delay(WAIT_LIMIT_MS, controller.signal);
    const timedOut: WaitOutcome = new TimedOut(this.server);
    const first = await Promise.race([
      waiting.then((probe) => this.#outcomeOf(probe)),
      timer.then(() => timedOut),
    ]);
    controller.abort();
    await Promise.allSettled([waiting, timer]);
    return first;
  }

  #outcomeOf(probe: ProcessOutcome): WaitOutcome {
    if (probe.code !== 0) return new WaitFailed(this.server, probe.code);
    // stdout `docker wait` — код выхода контейнера одной строкой.
    return probe.stdout.trim() === "0"
      ? new Succeeded(this.server)
      : new Failed(this.server);
  }
}

/** Миграции прошли: печатается число строк `public.migrations`. */
class Succeeded implements WaitOutcome {
  constructor(private readonly server: string) {}

  async report(context: MigrationsContext): Promise<number> {
    const probe = await context.docker.probe(
      [
        "docker",
        "exec",
        `${this.server}-pg`,
        "sh",
        "-c",
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc ' +
          '"select count(*) from public.migrations"',
      ],
      context.cwd,
    );
    // Не снятый счёт — не отказ: миграции уже подтверждены кодом
    // контейнера, число лишь показывает, сколько их (решение хоста 3).
    const count = probe.code === 0 ? probe.stdout.trim() : "?";
    context.progress(
      `${this.server}: миграции ок, ${count} в public.migrations`,
    );
    return 0;
  }
}

/** Контейнер миграций вышел с кодом ≠ 0: хвост его лога — оператору. */
class Failed implements WaitOutcome {
  constructor(private readonly server: string) {}

  async report(context: MigrationsContext): Promise<number> {
    context.progress(`mpu mp-init: миграции ${this.server} упали`);
    const logs = await context.docker.probe(
      ["docker", "logs", "--tail", "30", `${this.server}-migrations`],
      context.cwd,
    );
    // docker logs раскладывает поток контейнера по двум своим; ошибка
    // node — в stderr. Порядок строк между потоками не сохраняется.
    for (const line of linesOf(logs.stdout + logs.stderr)) {
      context.progress(line);
    }
    return 1;
  }
}

/** Контейнер не завершился за срок. */
class TimedOut implements WaitOutcome {
  constructor(private readonly server: string) {}

  report(context: MigrationsContext): Promise<number> {
    context.progress(
      `mpu mp-init: миграции ${this.server}: нет завершения за 10 мин`,
    );
    return Promise.resolve(1);
  }
}

/** Сам `docker wait` не ответил (контейнера нет): проверки не было. */
class WaitFailed implements WaitOutcome {
  constructor(
    private readonly server: string,
    private readonly rc: number,
  ) {}

  report(context: MigrationsContext): Promise<number> {
    context.progress(
      `mpu mp-init: миграции ${this.server}: docker wait упал (rc=${this.rc})`,
    );
    return Promise.resolve(1);
  }
}

/** Непустые строки текста без хвостового перевода. */
function linesOf(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}
