/**
 * Долгий опрос `getUpdates` (`docs/specs/platform/telegram-questions.md`,
 * «Приём апдейтов»): каждый апдейт подтверждается следующим `offset`,
 * сбой опроса ядро не роняет — следующая попытка через 5 с.
 */

import { type BotApi, BotFailure } from "./bot_api.ts";
import { ANY_AGE, type Freshness, type Inbox, SinceStart } from "./updates.ts";

/** Пауза после сбоя опроса. */
export const RETRY_MS = 5000;

/** Часы и пауза: параметром, чтобы тест вёл время сам. */
export interface Clock {
  /** Сейчас, мс Unix. */
  now(): number;
  /** Пауза; прерывается сигналом (промис отвергается). */
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

/** Настоящие часы. */
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  pause: (ms, signal) =>
    new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
    }),
};

/**
 * Серия отказов `409`: строка в журнал — одна на серию, серия кончается
 * удачным опросом.
 */
class Conflicts {
  readonly #diagnose: (line: string) => void;
  #told = false;

  constructor(diagnose: (line: string) => void) {
    this.#diagnose = diagnose;
  }

  failed(err: BotFailure): void {
    if (!err.isConflict() || this.#told) return;
    this.#told = true;
    this.#diagnose("telegram: у бота другой читатель (409)");
  }

  succeeded(): void {
    this.#told = false;
  }
}

/** Опрос апдейтов бота. */
export class Poller {
  readonly #bot: BotApi;
  readonly #inbox: Inbox;
  readonly #clock: Clock;
  readonly #conflicts: Conflicts;

  constructor(options: {
    readonly bot: BotApi;
    readonly inbox: Inbox;
    readonly clock: Clock;
    readonly diagnose: (line: string) => void;
  }) {
    this.#bot = options.bot;
    this.#inbox = options.inbox;
    this.#clock = options.clock;
    this.#conflicts = new Conflicts(options.diagnose);
  }

  /** Опрашивает до сигнала остановки. */
  async run(signal: AbortSignal): Promise<void> {
    // Дата апдейта — секунды: накопленное до старта отбрасывает только
    // первый опрос.
    let fresh: Freshness = new SinceStart(
      Math.floor(this.#clock.now() / 1000),
    );
    let offset = 0;
    while (!signal.aborted) {
      let updates;
      try {
        updates = await this.#bot.updates(offset, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (!(err instanceof BotFailure)) throw err;
        this.#conflicts.failed(err);
        if (!await this.#rested(signal)) return;
        continue;
      }
      this.#conflicts.succeeded();
      for (const update of updates) {
        // Сдвиг — до доставки: отброшенный и неудачный апдейт тоже
        // подтверждается, иначе Telegram отдавал бы его снова и снова.
        offset = update.id + 1;
        await update.deliver(this.#inbox, fresh);
      }
      fresh = ANY_AGE;
    }
  }

  /** Пауза перед повтором; `false` — прервана остановкой. */
  async #rested(signal: AbortSignal): Promise<boolean> {
    try {
      await this.#clock.pause(RETRY_MS, signal);
      return true;
    } catch (err) {
      if (signal.aborted) return false;
      throw err;
    }
  }
}
