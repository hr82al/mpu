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

/** Решён ли вопрос в другом месте: текст решения или его отсутствие. */
export type Settled =
  | { readonly settled: string }
  | { readonly failed: string };

/** Решения в другом месте нет: номер отозван или ответ не по контракту. */
const UNDECIDED: Settled = { failed: "решения в другом месте нет" };

/** Тело ответа `…/settled`: `{"settled": "<текст>"}`; иное — решения нет. */
function settledOf(text: string): Settled {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return UNDECIDED;
  }
  if (typeof body !== "object" || body === null) return UNDECIDED;
  const said = Reflect.get(body, "settled");
  return typeof said === "string" ? { settled: said } : UNDECIDED;
}

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
   *   строки у `POST`-двери (`platform/back-http-line.md`); `caller` —
   *   как агентская сессия называет себя (`platform/it.md`)
   */
  start(
    words: readonly string[],
    human: boolean,
    options: { readonly signal?: AbortSignal; readonly caller?: string } = {},
  ): Promise<Reply> {
    return this.#post(
      "/agent/line",
      {
        words,
        cwd: this.#target.cwd,
        human,
        caller: options.caller,
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
   * Ждёт решения вопроса по номеру в другом месте — владельцем в Telegram
   * (`platform/ask-telegram.md` [D.3]): решено — текст решения, строка ждёт
   * ответа по номеру; номер отозван (ответ пришёл, срок вышел) или ответ не
   * по контракту — решения нет.
   *
   * @param options `signal` — ждать перестали: форма ответила раньше или
   *   вызов отменён; тогда наружу уходит отказ сигнала
   */
  async settled(
    ticket: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Settled> {
    const response = await this.#reach(
      "/agent/line/settled",
      JSON.stringify({ ticket }),
      options.signal,
    );
    if (response === undefined) return UNDECIDED;
    const text = await response.text();
    return response.status === 200 ? settledOf(text) : UNDECIDED;
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
