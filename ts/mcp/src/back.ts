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

/**
 * Пауза между повторами, которую прекращает отмена вызова: ждать
 * поднятия `back` ради вызова, которого больше никто не слушает,
 * незачем (`platform/mcp-cancel.md`).
 *
 * @param ms сколько ждать
 * @param signal отмена вызова; взведён — ожидание кончается отказом
 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
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

  /**
   * Строка `words` в канале агента.
   *
   * @param options отмена вызова: обрыв чтения ответа и есть отмена
   *   строки у `POST`-двери (`platform/back-http-line.md`)
   */
  start(
    words: readonly string[],
    human: boolean,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Reply> {
    return this.#post(
      "/agent/line",
      {
        words,
        cwd: this.#target.cwd,
        human,
      },
      offContract(404),
      options.signal,
    );
  }

  /** Ответ на вопрос строки по номеру. */
  answer(
    ticket: string,
    answer: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Reply> {
    // 404 на ответ — номер истёк, пока человек думал.
    return this.#post(
      "/agent/line/answer",
      { ticket, answer },
      EXPIRED,
      options.signal,
    );
  }

  /**
   * @param missing исход на 404 от `back`
   * @param signal отмена вызова; взведён — запрос рвётся, и наружу
   *   уходит отказ сигнала, а не ответ
   */
  async #post(
    path: string,
    body: unknown,
    missing: Reply,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const response = await this.#reach(path, JSON.stringify(body), signal);
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
  async #reach(
    path: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response | undefined> {
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
          signal,
        });
      } catch (err) {
        // `fetch` отвергает сетевой сбой именно `TypeError`: `back` не
        // слушает. Прочее — отмену вызова в том числе — наружу: ждать
        // ради вызова, которого никто не слушает, незачем.
        if (!(err instanceof TypeError)) throw err;
        if (Date.now() >= until) return undefined;
        await pause(this.#patience.everyMs, signal);
      }
    }
  }
}
