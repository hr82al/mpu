/**
 * Спросить человека (`platform/mcp-objects.md`, «Вопрос подтверждения»):
 * клиент с elicitation получает форму голдена `fixtures/mcp-objects/`,
 * клиент без неё — никого. Выбирается один раз, при `initialize`.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ElicitResult,
  EmptyResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Ответ строке: да или нет. */
export type Verdict = "y" | "n";

/**
 * Сколько ждать ответа человека: срок номера у `back`
 * (`back/src/backend/line.ts`, `ANSWER_TIMEOUT_MS`). Импортировать его
 * нельзя — из `back/` переводчик берёт только контракт кадров, — поэтому
 * совпадение литералов сверяет `mcp/src/tasks_test.ts`.
 */
export const ELICIT_TIMEOUT_MS = 120_000;

/** Кто отвечает на вопрос строки. */
export interface Asker {
  /** Поле `human` строки. */
  readonly human: boolean;
  /**
   * @param question текст вопроса строки
   * @param requestId вызов тула, в поток которого уходит вопрос
   * @param options отмена вызова: вопрос снимается вместе с ним, и
   *   ответ в `back` не уходит вовсе (`platform/mcp-cancel.md`)
   */
  ask(
    question: string,
    requestId: string | number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Verdict>;
}

/**
 * Ответ формы — «да» тогда и только тогда, когда человек нажал Accept
 * (`action: "accept"`); содержимое не читается — у формы нет полей, а
 * старый клиент может прислать лишнее. Отказ и отмена — «нет».
 */
export function verdictOf(result: ElicitResult): Verdict {
  return result.action === "accept" ? "y" : "n";
}

/**
 * Форма подтверждения без полей (голден `elicitation.json`): у человека
 * только Accept / Decline.
 */
const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {},
};

/** Сколько ждать ответа на `ping`, которым тратится номер 0. */
const PING_MS = 5_000;

/** Номер 0 запросов сессии к клиенту: потрачен или ещё нет. */
interface ZeroId {
  /**
   * Потратить номер, если ещё не потрачен, в поток вызова `requestId`.
   *
   * @param signal отмена вызова или решение в другом месте: ждать ping
   *   незачем, номер он уже занял
   */
  spend(
    server: Server,
    requestId: string | number,
    signal?: AbortSignal,
  ): Promise<void>;
}

const SPENT: ZeroId = { spend: () => Promise.resolve() };

/**
 * Номер 0 не потрачен. Claude Code отмену запроса с номером 0 не
 * исполняет — форма остаётся на экране (проба R3-2, голден
 * `live-elicitation-cancel-id0-ignored.jsonl`), — поэтому форма номера 0
 * не получает: его забирает `ping` в поток того же вызова тула.
 */
const UNSPENT: ZeroId = {
  async spend(server, requestId, signal) {
    // Свой сигнал — только на время ping: слушатель отмены SDK со
    // своего сигнала не снимает, и поздняя отмена вызова послала бы
    // клиенту отмену уже отвеченного ping.
    const pinging = new AbortController();
    const stop = () => pinging.abort(signal?.reason);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted === true) stop();
    try {
      await server.request({ method: "ping" }, EmptyResultSchema, {
        relatedRequestId: requestId,
        timeout: PING_MS,
        signal: pinging.signal,
      });
    } catch {
      // Ответ на ping не нужен: номер потрачен самим запросом, а форма
      // спросит и без него.
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  },
};

/** Клиент с elicitation: вопрос — форма в той же сессии. */
class Eliciting implements Asker {
  readonly human = true;
  readonly #server: Server;
  #zero: ZeroId = UNSPENT;

  constructor(server: Server) {
    this.#server = server;
  }

  async ask(
    question: string,
    requestId: string | number,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Verdict> {
    // Состояние меняется до ожидания: вопрос, пришедший, пока идёт ping,
    // номер 0 уже не тратит — тот занят.
    const zero = this.#zero;
    this.#zero = SPENT;
    await zero.spend(this.#server, requestId, options.signal);
    try {
      return verdictOf(
        await this.#server.elicitInput(
          {
            mode: "form",
            message: question,
            requestedSchema: CONFIRM_SCHEMA,
          },
          // Вопрос — в поток того же вызова тула: отдельного потока
          // клиент может и не открыть, и запрос пропал бы молча.
          {
            relatedRequestId: requestId,
            timeout: ELICIT_TIMEOUT_MS,
            signal: options.signal,
          },
        ),
      );
    } catch (err) {
      // Вызов отменён — это не ответ человека: форма снята вместе с
      // вызовом, и в `back` не уходит ничего. «Нет» здесь записало бы
      // строке отказ от имени человека, который ничего не выбирал.
      if (options.signal?.aborted === true) throw err;
      // Ошибка, таймаут, обрыв — ответа человека нет, это «нет».
      return "n";
    }
  }
}

/**
 * Спрашивающий сессии клиента с elicitation: свой на каждую сессию —
 * номер 0 у каждой свой.
 */
export function eliciting(server: Server): Asker {
  return new Eliciting(server);
}

/** Клиент без elicitation: спросить некого, `back` и не спросит. */
export const NOBODY: Asker = {
  human: false,
  ask: () => Promise.resolve("n"),
};
