/**
 * Спросить человека (`platform/mcp-objects.md`, «Вопрос подтверждения»):
 * клиент с elicitation получает форму голдена `fixtures/mcp-objects/`,
 * клиент без неё — никого. Выбирается один раз, при `initialize`.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

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
 * Ответ формы — «да» только при `accept` с отмеченным `confirm`; снятый
 * флажок, отказ, отмена — «нет» (голден: Accept со снятым флажком — это
 * `accept` с `confirm: false`).
 */
export function verdictOf(result: ElicitResult): Verdict {
  return result.action === "accept" && result.content?.confirm === true
    ? "y"
    : "n";
}

/** Форма подтверждения (голден `elicitation.json`). */
const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: { type: "boolean" as const, title: "Выполнить?" },
  },
  required: ["confirm"],
};

/** Клиент с elicitation: вопрос — форма в той же сессии. */
export function eliciting(server: Server): Asker {
  return {
    human: true,
    async ask(question, requestId, options = {}) {
      try {
        return verdictOf(
          await server.elicitInput(
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
    },
  };
}

/** Клиент без elicitation: спросить некого, `back` и не спросит. */
export const NOBODY: Asker = {
  human: false,
  ask: () => Promise.resolve("n"),
};
