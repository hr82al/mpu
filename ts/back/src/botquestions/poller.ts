/**
 * Долгий опрос `getUpdates` (`docs/specs/platform/telegram-questions.md`,
 * «Приём апдейтов», «Уточнения R1a»): каждый апдейт подтверждается
 * следующим `offset`, сбой опроса ядро не роняет — следующая попытка
 * через 5 с.
 */

import { type BotApi, BotFailure } from "./bot_api.ts";
import { type Inbox, SinceStart } from "./updates.ts";

/** Пауза после сбоя опроса. */
export const RETRY_MS = 5000;

/** Часы и пауза: параметром, чтобы тест вёл время сам. */
export interface Clock {
  /** Сейчас, мс Unix. */
  now(): number;
  /**
   * Пауза; прерывается сигналом (промис отвергается) — и уже прерванным
   * до неё тоже.
   */
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

/** Настоящие часы. */
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  pause: (ms, signal) =>
    new Promise((resolve, reject) => {
      // Событие `abort` второй раз не придёт: прерванный до паузы сигнал
      // иначе оставил бы её ждать полный срок.
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
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
 * Серия сбоев опроса: строка в журнал — одна на серию `409` и одна на
 * серию прочих сбоев (сеть, 5xx); серия кончается удачным опросом.
 */
class Failures {
  readonly #diagnose: (line: string) => void;
  /** Сказано ли в этой серии про `409`. */
  #conflictTold = false;
  /** Сказано ли в этой серии про прочий сбой. */
  #otherTold = false;

  constructor(diagnose: (line: string) => void) {
    this.#diagnose = diagnose;
  }

  failed(err: BotFailure): void {
    if (err.isConflict()) {
      if (this.#conflictTold) return;
      this.#conflictTold = true;
      this.#diagnose("telegram: у бота другой читатель (409)");
      return;
    }
    if (this.#otherTold) return;
    this.#otherTold = true;
    this.#diagnose(`telegram: опрос не удался: ${err.reason}`);
  }

  succeeded(): void {
    this.#conflictTold = false;
    this.#otherTold = false;
  }
}

/** Опрос апдейтов бота. */
export class Poller {
  readonly #bot: BotApi;
  readonly #inbox: Inbox;
  readonly #clock: Clock;
  readonly #failures: Failures;

  constructor(options: {
    readonly bot: BotApi;
    readonly inbox: Inbox;
    readonly clock: Clock;
    readonly diagnose: (line: string) => void;
  }) {
    this.#bot = options.bot;
    this.#inbox = options.inbox;
    this.#clock = options.clock;
    this.#failures = new Failures(options.diagnose);
  }

  /** Опрашивает до сигнала остановки. */
  async run(signal: AbortSignal): Promise<void> {
    // Дата апдейта — секунды. Накопленное до старта отбрасывается в
    // любой пачке: Telegram отдаёт его и не первым опросом.
    const fresh = new SinceStart(Math.floor(this.#clock.now() / 1000));
    let offset = 0;
    while (!signal.aborted) {
      let updates;
      try {
        updates = await this.#bot.updates(offset, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (!(err instanceof BotFailure)) throw err;
        this.#failures.failed(err);
        if (!await this.#rested(signal)) return;
        continue;
      }
      this.#failures.succeeded();
      for (const update of updates) {
        // Сдвиг — до доставки: отброшенный и неудачный апдейт тоже
        // подтверждается, иначе Telegram отдавал бы его снова и снова.
        offset = update.id + 1;
        await update.deliver(this.#inbox, fresh);
      }
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
