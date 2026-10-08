/**
 * Строка экрана с подтверждением: строка → вопрос с номером → ответ
 * человека → итог. Открытый вопрос и последний итог — память хука; у
 * каждой поверхности (действия узлов) свой экземпляр, и итог
 * показывается у неё.
 */

import { useState } from "react";
import {
  answer,
  type LineReply,
  type Outcome,
  type Reply,
  sendLine,
} from "./api.ts";
import { useTransport } from "./transport.tsx";

/** Открытый вопрос: текст и номер ответа. */
export interface Pending {
  readonly question: string;
  readonly ticket: string;
}

export interface LineState {
  /** Вопрос ждёт ответа; нет — `undefined`. */
  readonly pending: Pending | undefined;
  /** Итог последней строки; строк не было — `undefined`. */
  readonly last: Outcome | undefined;
  /** Отправить строку. */
  send(words: readonly string[]): Promise<void>;
  /** Ответ человека на открытый вопрос. */
  respond(yes: boolean): Promise<void>;
}

/** Итог, которого `back` не дал: строка не дошла, причина — в `stderr`. */
function undelivered(text: string): Outcome {
  return { stdout: "", stderr: `${text}\n`, exit: 1 };
}

/**
 * Текст под полем или кнопкой: `stderr` итога без последнего перевода
 * строки; у отказа объектом это `refusal.text`.
 */
export function told(outcome: Outcome | undefined): string {
  return (outcome?.stderr ?? "").replace(/\n$/, "");
}

/** Ответ транспорта строкой: недоставленная — итог с причиной. */
function lineOf(reply: Reply<LineReply>): LineReply {
  switch (reply.kind) {
    case "loaded":
      return reply.value;
    case "no-session":
      return {
        kind: "outcome",
        outcome: undelivered("Сессия истекла — откройте ссылку из mpu web"),
      };
    case "unreachable":
      return {
        kind: "outcome",
        outcome: undelivered(`mpu-back недоступен на ${reply.base}`),
      };
  }
}

/**
 * @param changed зовётся после итога строки (не вопроса) — перечитать
 *   дерево: итог с любым кодом мог изменить базу
 */
export function useLine(changed: () => void): LineState {
  const transport = useTransport();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [last, setLast] = useState<Outcome | undefined>(undefined);

  const settle = (reply: Reply<LineReply>) => {
    const line = lineOf(reply);
    switch (line.kind) {
      case "question":
        setPending({ question: line.ask, ticket: line.ticket });
        return;
      case "outcome":
        setPending(undefined);
        setLast(line.outcome);
        changed();
        return;
    }
  };

  return {
    pending,
    last,
    async send(words) {
      try {
        settle(await sendLine(transport, words));
      } catch (err) {
        // Ответ не разобрался — строка не дошла; сказать, а не молчать.
        setLast(undelivered(`ответ mpu-back не разобран: ${String(err)}`));
      }
    },
    async respond(yes) {
      if (pending === undefined) return;
      const ticket = pending.ticket;
      setPending(undefined);
      try {
        settle(await answer(transport, ticket, yes));
      } catch (err) {
        setLast(undelivered(`ответ mpu-back не разобран: ${String(err)}`));
      }
    },
  };
}
