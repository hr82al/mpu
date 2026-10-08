/**
 * Сессии Claude Code по ключу (`claude-channel.md`, «Ключ сессии»,
 * «Регистрация в ядре»; `claude-hook-stop.md`, «Исходы»): у сессии один
 * вопрос «ждёт ввода» — новый конец хода снимает прежний — и не больше
 * одного канала — второй вытесняет первый. Ключ —
 * `CLAUDE_CODE_MESSAGING_SOCKET` клиента; значение живёт только внутри
 * реестра и наружу не выдаётся.
 */

import type { Asked, Clock } from "../botquestions/mod.ts";
import { SESSION_ENV } from "@mpu/language/frames";
import { TERMINAL } from "./decision.ts";
import { NO_CHANNEL, type Reach } from "./reach.ts";
import type { CallerEnv } from "./window.ts";

/**
 * Срок доставки текста в канал: дольше — отказ. Без срока зависший
 * канал держал бы приём всех апдейтов бота (`Queue.write` ждёт доставку);
 * постановка R2 (§7) — «не позже 2 с».
 */
export const DELIVERY_MS = 2000;

/** Исход вопроса «ждёт ввода», когда регистрация канала оборвалась [S9]. */
export const SESSION_CLOSED = "⌛ сессия закрыта";

/**
 * Исход снимка окна, когда у сессии появился структурный вопрос
 * (`claude-hook-notification-snapshot.md`, «Исходы»).
 */
export const QUESTION_IN_CHAT = "↷ вопрос в чате";

/** Канал сессии глазами ядра. */
export interface Link {
  /** Текст в сессию; ответ — доставлен ли. */
  deliver(text: string): Promise<boolean>;
  /**
   * Достижимость сессии через этот канал; доставка идёт через `session`
   * — в её канал на момент доставки.
   */
  reach(session: Session): Reach;
}

/** Канала нет: доставлять некуда. Памяти нет — один экземпляр. */
const NO_LINK: Link = {
  deliver: () => Promise.resolve(false),
  reach: () => NO_CHANNEL,
};

/** Вопрос сессии глазами реестра. */
type SessionAsked = Pick<Asked, "withdraw" | "withdrawAs">;

/** Вопроса у сессии нет: снимать нечего. */
const NOT_ASKED: SessionAsked = { withdraw: () => {}, withdrawAs: () => {} };

/**
 * Одна сессия: её вопросы в ряду — «ждёт ввода», срочные (право,
 * AskUserQuestion, подтверждение `ask`, форма MCP), снимок окна — и
 * текущий канал.
 */
export class Session {
  readonly #clock: Clock;
  /** Все вопросы сессии в ряду. */
  readonly #all = new Set<SessionAsked>();
  #asked: SessionAsked = NOT_ASKED;
  #snapshot: SessionAsked = NOT_ASKED;
  /**
   * Висящие вопросы о праве и AskUserQuestion: их снимает следующее
   * событие сессии (`claude-hook-permission-request.md`, «Решено в другом
   * месте»).
   */
  readonly #permissions = new Set<SessionAsked>();
  #link: Link = NO_LINK;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Новый вопрос сессии: прежний снимается «решено в терминале» — раньше,
   * чем задан новый, чтобы ряд не показал их рядом.
   */
  replace(ask: () => Asked): Asked {
    this.#asked.withdraw(TERMINAL);
    const asked = this.urgent(ask);
    this.#asked = asked;
    return asked;
  }

  /**
   * Срочный вопрос сессии (подтверждение `ask`, форма MCP; основа права и
   * «ждёт ввода»): снимок окна той же сессии снимается — ожидание теперь в
   * чате.
   */
  urgent(ask: () => Asked): Asked {
    this.#snapshot.withdrawAs(QUESTION_IN_CHAT);
    const asked = ask();
    this.#all.add(asked);
    return asked;
  }

  /**
   * Вопрос о праве (или AskUserQuestion): его снимет следующее событие
   * сессии (`movedOn`).
   */
  permission(ask: () => Asked): Asked {
    const asked = this.urgent(ask);
    this.#permissions.add(asked);
    return asked;
  }

  /**
   * Следующее событие сессии (форма MCP, ожидание ввода, конец хода):
   * висящие вопросы о праве решены в терминале.
   */
  movedOn(): void {
    for (const asked of this.#permissions) asked.withdraw(TERMINAL);
    this.#permissions.clear();
  }

  /**
   * Снимок окна сессии — только если у неё нет вопроса в ряду: решение и
   * постановка — в одном синхронном шаге, без ожидания между ними, чтобы
   * структурный вопрос или второй снимок не встали в зазор.
   */
  snapshot<T>(ask: () => Asked, seat: SnapshotSeat<T>): T {
    if (this.#all.size > 0) return seat.busy();
    const asked = ask();
    this.#snapshot = asked;
    this.#all.add(asked);
    return seat.seated(asked);
  }

  /** Вопрос `asked` решён: забыть. */
  leave(asked: Asked): void {
    this.#all.delete(asked);
    this.#permissions.delete(asked);
    if (this.#asked === asked) this.#asked = NOT_ASKED;
    if (this.#snapshot === asked) this.#snapshot = NOT_ASKED;
  }

  /** Канал сессии; прежний вытеснен — его закрытие ничего не снимает. */
  attach(link: Link): void {
    this.#link = link;
  }

  /**
   * Канал `link` закрылся. Был текущим — вопрос сессии снят «сессия
   * закрыта»; вытесненный — ничего.
   */
  detach(link: Link): void {
    if (this.#link !== link) return;
    this.#link = NO_LINK;
    this.#asked.withdrawAs(SESSION_CLOSED);
  }

  /** Достижимость сессии сейчас. */
  reach(): Reach {
    return this.#link.reach(this);
  }

  /**
   * Текст в текущий канал сессии; не ответил за `DELIVERY_MS` — отказ.
   * Канал — текущий на момент доставки: вытеснивший получает текст.
   */
  async deliver(text: string): Promise<boolean> {
    const done = new AbortController();
    const late = this.#clock.pause(DELIVERY_MS, done.signal).then(
      () => false,
      // Пауза прервана: доставка ответила раньше срока.
      () => false,
    );
    try {
      return await Promise.race([this.#link.deliver(text), late]);
    } finally {
      done.abort();
      await late;
    }
  }
}

/**
 * Сессии по ключу. Сессия, раз появившись, помнится до конца процесса
 * ядра: их число — число сессий Claude Code за его жизнь.
 */
export class Sessions {
  readonly #clock: Clock;
  readonly #sessions = new Map<string, Session>();

  /** @param clock срок доставки в канал */
  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Сессия `socket`; нет — заводится. */
  of(socket: string): Session {
    const known = this.#sessions.get(socket);
    if (known !== undefined) return known;
    const session = new Session(this.#clock);
    this.#sessions.set(socket, session);
    return session;
  }
}

/** Чем кончилась попытка поставить снимок. */
export interface SnapshotSeat<T> {
  /** Поставлен. */
  seated(asked: Asked): T;
  /** У сессии уже есть вопрос в ряду — ожидание в чате. */
  busy(): T;
}

/** Ключ сессии глазами стола. */
export interface SessionKey {
  /** Задаёт вопрос сессии; прежний вопрос той же сессии снят. */
  seat(sessions: Sessions, ask: () => Asked): Asked;
  /** Задаёт срочный вопрос сессии (подтверждение `ask`, форма MCP). */
  seatUrgent(sessions: Sessions, ask: () => Asked): Asked;
  /** Задаёт вопрос о праве (или AskUserQuestion) сессии. */
  seatPermission(sessions: Sessions, ask: () => Asked): Asked;
  /** Следующее событие сессии: её вопросы о праве сняты. */
  movedOn(sessions: Sessions): void;
  /** Задаёт снимок окна сессии, если у неё нет вопроса в ряду. */
  seatSnapshot<T>(
    sessions: Sessions,
    ask: () => Asked,
    seat: SnapshotSeat<T>,
  ): T;
  /** Вопрос `asked` решён. */
  leave(sessions: Sessions, asked: Asked): void;
  /** Достижимость сессии: есть ли у неё канал. */
  reach(sessions: Sessions): Reach;
}

/** Ключ — сокет сессии. */
class SocketKey implements SessionKey {
  readonly #socket: string;

  constructor(socket: string) {
    this.#socket = socket;
  }

  seat(sessions: Sessions, ask: () => Asked): Asked {
    return sessions.of(this.#socket).replace(ask);
  }

  seatUrgent(sessions: Sessions, ask: () => Asked): Asked {
    return sessions.of(this.#socket).urgent(ask);
  }

  seatPermission(sessions: Sessions, ask: () => Asked): Asked {
    return sessions.of(this.#socket).permission(ask);
  }

  movedOn(sessions: Sessions): void {
    sessions.of(this.#socket).movedOn();
  }

  seatSnapshot<T>(
    sessions: Sessions,
    ask: () => Asked,
    seat: SnapshotSeat<T>,
  ): T {
    return sessions.of(this.#socket).snapshot(ask, seat);
  }

  leave(sessions: Sessions, asked: Asked): void {
    sessions.of(this.#socket).leave(asked);
  }

  reach(sessions: Sessions): Reach {
    return sessions.of(this.#socket).reach();
  }
}

/**
 * Ключа клиент не принёс (вызов не из Claude Code): чья сессия — не
 * узнать, вопросы не сменяют друг друга, канала нет.
 */
const NO_KEY: SessionKey = {
  seat: (_, ask) => ask(),
  seatUrgent: (_, ask) => ask(),
  seatPermission: (_, ask) => ask(),
  movedOn: () => {},
  seatSnapshot: (_, ask, seat) => seat.seated(ask()),
  leave: () => {},
  reach: () => NO_CHANNEL,
};

/**
 * Вопрос сессии `asked`, пока идёт ожидание `wait`: после исхода — и после
 * сбоя ожидания — сессия его отпускает и снимок окна снова может сесть.
 */
export async function heldWhile<T>(
  key: SessionKey,
  sessions: Sessions,
  asked: Asked,
  wait: () => Promise<T>,
): Promise<T> {
  try {
    return await wait();
  } finally {
    key.leave(sessions, asked);
  }
}

/** Ключ сессии по окружению клиента; нет или пусто — `NO_KEY`. */
export function sessionKeyOf(env: CallerEnv): SessionKey {
  const socket = env(SESSION_ENV) ?? "";
  return socket === "" ? NO_KEY : new SocketKey(socket);
}
