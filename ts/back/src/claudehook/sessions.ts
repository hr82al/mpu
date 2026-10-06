/**
 * Сессии Claude Code по ключу (`claude-channel.md`, «Ключ сессии»;
 * `claude-hook-stop.md`, «Исходы»): у сессии один вопрос «ждёт ввода» —
 * новый конец хода снимает прежний. Ключ — `CLAUDE_CODE_MESSAGING_SOCKET`
 * клиента; значение живёт только внутри ключа и наружу не выдаётся.
 * Следующим сюда придёт канал сессии (R2b).
 */

import type { Asked } from "../botquestions/mod.ts";
import { SESSION_ENV } from "../frames/mod.ts";
import type { CallerEnv } from "./window.ts";
import { TERMINAL } from "./decision.ts";

/** Прежнего вопроса у сессии нет: снимать нечего. */
const NOT_ASKED: Pick<Asked, "withdraw"> = { withdraw: () => {} };

/** Текущие вопросы сессий. */
export class Sessions {
  readonly #asked = new Map<string, Asked>();

  /**
   * Вопрос сессии `socket`: прежний снимается «решено в терминале» —
   * раньше, чем задан новый, чтобы ряд не показал их рядом.
   */
  replace(socket: string, ask: () => Asked): Asked {
    (this.#asked.get(socket) ?? NOT_ASKED).withdraw(TERMINAL);
    const asked = ask();
    this.#asked.set(socket, asked);
    return asked;
  }

  /** Вопрос `asked` сессии `socket` решён: забыть, если он ещё её. */
  leave(socket: string, asked: Asked): void {
    if (this.#asked.get(socket) === asked) this.#asked.delete(socket);
  }
}

/** Ключ сессии глазами стола. */
export interface SessionKey {
  /** Задаёт вопрос сессии; прежний вопрос той же сессии снят. */
  seat(sessions: Sessions, ask: () => Asked): Asked;
  /** Вопрос `asked` решён. */
  leave(sessions: Sessions, asked: Asked): void;
}

/** Ключ — сокет сессии. */
class SocketKey implements SessionKey {
  readonly #socket: string;

  constructor(socket: string) {
    this.#socket = socket;
  }

  seat(sessions: Sessions, ask: () => Asked): Asked {
    return sessions.replace(this.#socket, ask);
  }

  leave(sessions: Sessions, asked: Asked): void {
    sessions.leave(this.#socket, asked);
  }
}

/**
 * Ключа клиент не принёс (вызов не из Claude Code): чья сессия — не
 * узнать, вопросы не сменяют друг друга.
 */
const NO_KEY: SessionKey = {
  seat: (_, ask) => ask(),
  leave: () => {},
};

/** Ключ сессии по окружению клиента; нет или пусто — `NO_KEY`. */
export function sessionKeyOf(env: CallerEnv): SessionKey {
  const socket = env(SESSION_ENV) ?? "";
  return socket === "" ? NO_KEY : new SocketKey(socket);
}
