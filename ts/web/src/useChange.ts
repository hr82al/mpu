/**
 * Изменение правила с подтверждением: строка → вопрос с номером → ответ
 * человека. Открытый вопрос — память хука; наружу — «ответить».
 */

import { useState } from "react";
import { answer, changeRule, type LineResult } from "./api.ts";
import { useTransport } from "./transport.tsx";

/** Открытый вопрос: текст и номер ответа. */
export interface Pending {
  readonly question: string;
  readonly ticket: string;
}

export interface Change {
  /** Вопрос ждёт ответа; нет — `undefined`. */
  readonly pending: Pending | undefined;
  /** Текст отказа последней строки; нет — пусто. */
  readonly failure: string;
  /** Отправить строку изменения (`["deny:", "kiten"]`). */
  start(words: readonly string[]): Promise<void>;
  /** Ответ человека на открытый вопрос. */
  respond(yes: boolean): Promise<void>;
}

/**
 * @param changed зовётся, когда строка дошла до конца (перечитать дерево)
 */
export function useChange(changed: () => void): Change {
  const transport = useTransport();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [failure, setFailure] = useState("");

  const settle = (reply: Awaited<ReturnType<typeof changeRule>>) => {
    if (reply.kind !== "loaded") {
      setPending(undefined);
      setFailure(
        reply.kind === "no-session"
          ? "Сессия истекла — откройте ссылку из mpu-next web"
          : `mpu-back недоступен на ${reply.base}`,
      );
      return;
    }
    const result: LineResult = reply.value;
    if ("ticket" in result) {
      setPending({ question: result.ask, ticket: result.ticket });
      return;
    }
    setPending(undefined);
    setFailure(result.exit === 0 ? "" : result.stderr.trim());
    changed();
  };

  return {
    pending,
    failure,
    async start(words) {
      setFailure("");
      try {
        settle(await changeRule(transport, words));
      } catch (err) {
        // Ответ не разобрался — строка не дошла; сказать, а не молчать.
        setFailure(`ответ mpu-back не разобран: ${String(err)}`);
      }
    },
    async respond(yes) {
      if (pending === undefined) return;
      const ticket = pending.ticket;
      setPending(undefined);
      try {
        settle(await answer(transport, ticket, yes));
      } catch (err) {
        setFailure(`ответ mpu-back не разобран: ${String(err)}`);
      }
    },
  };
}
