/**
 * Хук `Notification` в ядре (`claude-hook-notification-snapshot.md`,
 * «Когда приходит снимок»; строка-уведомление — `claude-hook-notification.md`):
 * не ожидание или ожидание без окна — строка в бота, как прежде; ожидание с
 * окном — через 3 с, если у сессии нет вопроса в ряду, вопрос-снимок окна.
 * Хук со снимком выходит сразу; снимок живёт в ядре до исхода.
 */

import {
  type Asked,
  type Clock,
  NO_BOT,
  type OwnerQuestions,
  REAL_CLOCK,
} from "../botquestions/mod.ts";
import { UsageError } from "../command/mod.ts";
import {
  type HookPayload,
  notificationMovesOn,
  notificationSilent,
  notificationText,
  notificationWaits,
  parseHookPayload,
  transcriptPathOf,
} from "./payload.ts";
import { dialogOf } from "./screen.ts";
import { placesOf, projectOf } from "./places.ts";
import { DECIDED, type HookReply, type HookSpeech } from "./reply.ts";
import { type SessionKey, sessionKeyOf, Sessions } from "./sessions.ts";
import { Snapshot } from "./snapshot.ts";
import { QUIET } from "./stop.ts";
import { NO_TRANSCRIPTS, type Transcripts, TYPED_INPUT } from "./transcript.ts";
import {
  type CallerEnv,
  NO_WINDOWS,
  type Pane,
  type Windows,
} from "./window.ts";

/** Через сколько смотреть, пришёл ли вопрос сессии хуками R1–R3. */
export const SETTLE_QUESTION_MS = 3000;

/** Строка stderr отказа: тот же вид, что у прежней команды. */
function failed(reason: string): string {
  return `mpu claude-hook notification: ${reason}\n`;
}

/** Строка ушла: stdout — номер сообщения одной строкой JSON. */
class Sent implements HookReply {
  readonly #id: number;

  constructor(id: number) {
    this.#id = id;
  }

  tell(speech: HookSpeech) {
    speech.stdout(`{"id": ${this.#id}}\n`);
  }

  code = DECIDED;
}

/** Отказ: причина в stderr, код — как у прежней команды. */
class Refused implements HookReply {
  readonly #reason: string;
  readonly #code: number;

  constructor(reason: string, code: number) {
    this.#reason = reason;
    this.#code = code;
  }

  tell(speech: HookSpeech) {
    speech.stderr(failed(this.#reason));
  }

  code(): number {
    return this.#code;
  }
}

/** stdin не JSON-объект: код 2, как у прежней команды. */
const BAD_INPUT = new Refused("stdin хука разбирается как JSON-объект", 2);

/** Что нужно столу. */
export interface NotifyDeskParts {
  readonly questions: Pick<OwnerQuestions, "ask" | "post">;
  readonly transcripts: Transcripts;
  readonly windows: Windows;
  readonly sessions: Sessions;
  /** Пауза 3 с и паузы снимка. */
  readonly clock: Clock;
  readonly diagnose: (line: string) => void;
}

/** Хук `Notification`. */
export class NotifyDesk {
  readonly #parts: NotifyDeskParts;
  /** Остановка ядра: ожидания и снимки кончаются. */
  readonly #closing = new AbortController();
  /** Ожидания решения и снимки — во владении стола. */
  readonly #watching = new Set<Promise<void>>();

  constructor(parts: NotifyDeskParts) {
    this.#parts = parts;
  }

  /** Ответ хука на stdin `text`; окружение клиента — `env`. */
  async reply(text: string, env: CallerEnv): Promise<HookReply> {
    let payload: HookPayload;
    try {
      payload = parseHookPayload(text);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      return BAD_INPUT;
    }
    if (notificationMovesOn(payload)) {
      sessionKeyOf(env).movedOn(this.#parts.sessions);
    }
    if (notificationSilent(payload)) return QUIET;
    const line = () => this.#line(payload);
    if (!notificationWaits(payload)) return await line();
    return await this.#parts.windows.paneOf(env).offer({
      none: line,
      window: (pane) => {
        this.#own(this.#later(pane, payload, env, line));
        return Promise.resolve(QUIET);
      },
    });
  }

  /** Остановка ядра: ожидания прерваны, снимки — «истёк». */
  async stop(): Promise<void> {
    this.#closing.abort();
    await Promise.all(this.#watching);
  }

  /** Строка-уведомление в бота. */
  async #line(payload: HookPayload): Promise<HookReply> {
    const posted = await this.#parts.questions.post({
      text: notificationText(payload),
      entities: [],
    });
    return posted.read<HookReply>({
      sent: (id) => new Sent(id),
      refused: (reason) => new Refused(reason, 1),
    });
  }

  /** Строка-уведомление после выхода хука: отказ — в журнал службы. */
  async #lateLine(line: () => Promise<HookReply>): Promise<void> {
    const reply = await line();
    reply.tell({
      stdout: () => {},
      stderr: (said) => this.#parts.diagnose(said.trimEnd()),
    });
  }

  #own(work: Promise<void>): void {
    const owned = work
      .catch((err) => {
        this.#parts.diagnose(`claude-hook notification: ${String(err)}`);
      })
      .finally(() => this.#watching.delete(owned));
    this.#watching.add(owned);
  }

  /**
   * Через `SETTLE_QUESTION_MS` экран окна: снять нельзя или диалога на нём
   * нет — строка-уведомление; есть — снимок, если у сессии нет вопроса в
   * ряду (ожидание уже в чате).
   */
  async #later(
    pane: Pane,
    payload: HookPayload,
    env: CallerEnv,
    line: () => Promise<HookReply>,
  ): Promise<void> {
    const closing = this.#closing.signal;
    try {
      await this.#parts.clock.pause(SETTLE_QUESTION_MS, closing);
    } catch (err) {
      if (!closing.aborted) throw err;
      return;
    }
    const next = await pane.look<() => Promise<void>>({
      seen: (screen) => () =>
        dialogOf(screen).waiting()
          ? this.#snapshot(pane, screen, payload, env)
          : this.#lateLine(line),
      gone: () => () => this.#lateLine(line),
      left: () => () => this.#lateLine(line),
    });
    await next();
  }

  async #snapshot(
    pane: Pane,
    screen: string,
    payload: HookPayload,
    env: CallerEnv,
  ): Promise<void> {
    const { questions, transcripts, windows, sessions, clock, diagnose } =
      this.#parts;
    // Всё, что ждёт, — до постановки: решение «есть ли у сессии вопрос» и
    // постановка снимка идут одним шагом сессии.
    const transcript = await transcripts.read(
      transcriptPathOf(payload),
      TYPED_INPUT,
    );
    const places = placesOf(
      transcript.title(),
      projectOf(payload.fields.cwd),
      await windows.captionOf(env),
    );
    const snapshot = new Snapshot(
      {
        pane,
        clock,
        post: (message) => questions.post(message),
        diagnose,
      },
      screen,
    );
    const key = sessionKeyOf(env);
    await key.seatSnapshot(
      sessions,
      () => questions.ask(snapshot.form(places)),
      {
        seated: (asked) => this.#watch(snapshot, asked, key),
        busy: () => Promise.resolve(),
      },
    );
  }

  /**
   * Снимок до исхода; остановка ядра — «истёк». Исход у снимка есть всегда,
   * и после сбоя: иначе срочный вопрос без исхода держал бы голову ряда.
   */
  async #watch(snapshot: Snapshot, asked: Asked, key: SessionKey) {
    const closing = this.#closing.signal;
    const expire = () => asked.expire();
    closing.addEventListener("abort", expire, { once: true });
    if (closing.aborted) expire();
    try {
      await snapshot.watch(asked, closing);
    } finally {
      closing.removeEventListener("abort", expire);
      asked.expire();
      key.leave(this.#parts.sessions, asked);
    }
    (await asked.outcome).read({
      answered: () => {},
      withdrawn: () => {},
      expired: () => {},
      refused: (reason) =>
        this.#parts.diagnose(
          `claude-hook notification: снимок не показан: ${reason}`,
        ),
    });
  }
}

/** Стол без бота: строка — отказ «бот не настроен», окна нет. */
export const NO_NOTIFY_DESK = new NotifyDesk({
  questions: NO_BOT,
  transcripts: NO_TRANSCRIPTS,
  windows: NO_WINDOWS,
  sessions: new Sessions(REAL_CLOCK),
  clock: REAL_CLOCK,
  diagnose: () => {},
});
