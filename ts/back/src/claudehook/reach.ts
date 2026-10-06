/**
 * Чем сессия отвечает на текст владельца в чате (`claude-hook-stop.md`,
 * «Вопрос „ждёт ввода“», «Исходы»): у сессии без канала — «ответьте в
 * терминале», у сессии с каналом (`claude-channel.md`) — доставка текста в
 * неё. Две реализации одного протокола, а не ветка по «есть ли канал».
 */

import {
  type Button,
  LATER,
  notice,
  SKIP,
  type TextRule,
  Written,
} from "../botquestions/mod.ts";

/** Достижимость сессии для вопроса «ждёт ввода». */
export interface Reach {
  /** Последние строки тела. */
  readonly tail: readonly string[];
  readonly reply: TextRule;
  /** Кнопки-действия сообщения. */
  readonly actions: readonly Button[];
}

/** Сессия без канала: ответ — только в терминале [S7]. */
export const NO_CHANNEL: Reach = {
  tail: ["ответ — в терминале (сессия без канала)"],
  reply: { write: () => notice("ответьте в терминале") },
  actions: [SKIP],
};

/** Куда доставляется текст сессии с каналом. */
export interface Delivery {
  /** Текст в канал сессии; ответ — доставлен ли. */
  deliver(text: string): Promise<boolean>;
}

/** Отказ доставки — владельцу (`platform/telegram-questions.md`, «R2»). */
const NOT_DELIVERED = "не доставлено: сессия без канала";

/**
 * Сессия с каналом: текст владельца — ответ шага, когда канал его
 * доставил; не доставил — вопрос активен, владельцу — отказ.
 */
export class ChannelReach implements Reach {
  readonly tail: readonly string[] = [];
  readonly actions: readonly Button[] = [LATER, SKIP];
  readonly reply: TextRule;

  /** @param delivery канал сессии — текущий на момент доставки */
  constructor(delivery: Delivery) {
    this.reply = {
      write: (text, events) => ({
        deliver: async (say) => {
          if (await delivery.deliver(text)) {
            events.answered(new Written(text));
            return;
          }
          await say(NOT_DELIVERED);
        },
      }),
    };
  }
}
