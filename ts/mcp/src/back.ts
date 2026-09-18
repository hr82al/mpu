/**
 * Строка `mpu-back` простым HTTP (`platform/back-http-line.md`) глазами
 * переводчика: `POST /agent/line` с основным токеном, собранный ответ,
 * ответ на вопрос по номеру. Недоступный `back` — повторы до срока.
 */

import {
  BadFrame,
  type Collected,
  collectedOf,
} from "../../back/src/frames/mod.ts";

/** Куда и как ходит переводчик. */
export interface BackTarget {
  /** Адрес `mpu-back`. */
  readonly base: string;
  /** Основной токен `back`: только с ним `human: true` на канале агента. */
  readonly token: string;
  /** Каталог строки. */
  readonly cwd: string;
}

/** Сколько ждать поднятия `back` и как часто пробовать. */
export interface Patience {
  readonly deadlineMs: number;
  readonly everyMs: number;
}

export const PATIENCE: Patience = { deadlineMs: 10_000, everyMs: 250 };

/** Что пришло от `back`: собранный ответ или отказ с текстом. */
export type Reply =
  | { readonly collected: Collected }
  | { readonly failed: string };

const EXPIRED: Reply = { failed: "подтверждение истекло" };

function offContract(status: number): Reply {
  return { failed: `mpu-back ответил не по контракту (${status})` };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Строка `back` для переводчика. */
export class BackLine {
  readonly #target: BackTarget;
  readonly #patience: Patience;
  readonly #fetch: typeof fetch;

  constructor(
    target: BackTarget,
    patience: Patience = PATIENCE,
    fetcher: typeof fetch = fetch,
  ) {
    this.#target = target;
    this.#patience = patience;
    this.#fetch = fetcher;
  }

  /** Строка `words` в канале агента. */
  start(words: readonly string[], human: boolean): Promise<Reply> {
    return this.#post("/agent/line", {
      words,
      cwd: this.#target.cwd,
      human,
    }, offContract(404));
  }

  /** Ответ на вопрос строки по номеру. */
  answer(ticket: string, answer: string): Promise<Reply> {
    // 404 на ответ — номер истёк, пока человек думал.
    return this.#post("/agent/line/answer", { ticket, answer }, EXPIRED);
  }

  /**
   * @param missing исход на 404 от `back`
   */
  async #post(path: string, body: unknown, missing: Reply): Promise<Reply> {
    const response = await this.#reach(path, JSON.stringify(body));
    if (response === undefined) {
      return { failed: `mpu-back недоступен на ${this.#target.base}` };
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { failed: `mpu-back отказал в доступе (${response.status})` };
    }
    if (response.status === 404) return missing;
    try {
      return { collected: collectedOf(text) };
    } catch (err) {
      if (!(err instanceof BadFrame)) throw err;
      return offContract(response.status);
    }
  }

  /** Ответ `back`; не поднялся до срока — ничего. */
  async #reach(path: string, body: string): Promise<Response | undefined> {
    const until = Date.now() + this.#patience.deadlineMs;
    while (true) {
      try {
        return await this.#fetch(new URL(path, this.#target.base), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#target.token}`,
            Accept: "application/json",
          },
          body,
        });
      } catch (err) {
        // `fetch` отвергает сетевой сбой именно `TypeError`: `back` не
        // слушает. Прочее (нет права на адрес) — не повод ждать.
        if (!(err instanceof TypeError)) throw err;
        if (Date.now() >= until) return undefined;
        await pause(this.#patience.everyMs);
      }
    }
  }
}
