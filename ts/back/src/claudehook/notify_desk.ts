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
import { notificationText, parseHookPayload } from "./payload.ts";
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

/** Ожидание: тип уведомления кончается на `_prompt` или `_dialog`. */
function waits(type: unknown): boolean {
  return typeof type === "string" && /_(prompt|dialog)$/.test(type);
}

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
    let fields: Readonly<Record<string, unknown>>;
    try {
      fields = parseHookPayload(text).fields;
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      return BAD_INPUT;
    }
    const line = () => this.#line(text);
    if (!waits(fields.notification_type)) return await line();
    return await this.#parts.windows.paneOf(env).offer({
      none: line,
      window: (pane) => {
        this.#own(this.#later(pane, fields, env, line));
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
  async #line(text: string): Promise<HookReply> {
    const posted = await this.#parts.questions.post({
      text: notificationText(parseHookPayload(text)),
      entities: [],
    });
    return posted.read<HookReply>({
      sent: (id) => new Sent(id),
      refused: (reason) => new Refused(reason, 1),
    });
  }

  #own(work: Promise<void>): void {
    const owned = work.catch((err) => {
      this.#parts.diagnose(`claude-hook notification: ${String(err)}`);
    }).finally(() => this.#watching.delete(owned));
    this.#watching.add(owned);
  }

  /**
   * Через `SETTLE_QUESTION_MS`: у сессии есть вопрос — ожидание уже в
   * чате; нет — снимок окна; окно не снимается — строка-уведомление.
   */
  async #later(
    pane: Pane,
    fields: Readonly<Record<string, unknown>>,
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
    const key = sessionKeyOf(env);
    if (key.asking(this.#parts.sessions)) return;
    const screen = await pane.look({ seen: (one) => one, gone: () => "" });
    if (screen === "") {
      const reply = await line();
      reply.tell({
        stdout: () => {},
        stderr: (said) => this.#parts.diagnose(said.trimEnd()),
      });
      return;
    }
    await this.#snapshot(pane, screen, fields, env, key);
  }

  async #snapshot(
    pane: Pane,
    screen: string,
    fields: Readonly<Record<string, unknown>>,
    env: CallerEnv,
    key: SessionKey,
  ): Promise<void> {
    const { questions, transcripts, windows, sessions, clock, diagnose } =
      this.#parts;
    const path = typeof fields.transcript_path === "string"
      ? fields.transcript_path
      : "";
    const transcript = await transcripts.read(path, TYPED_INPUT);
    const places = placesOf(
      transcript.title(),
      projectOf(fields.cwd),
      await windows.captionOf(env),
    );
    const snapshot = new Snapshot({
      pane,
      clock,
      post: (message) => questions.post(message),
      diagnose,
    }, screen);
    const asked: Asked = key.seatSnapshot(
      sessions,
      () => questions.ask(snapshot.form(places)),
    );
    const closing = this.#closing.signal;
    const expire = () => asked.expire();
    closing.addEventListener("abort", expire, { once: true });
    if (closing.aborted) expire();
    try {
      await snapshot.watch(asked, closing);
    } finally {
      closing.removeEventListener("abort", expire);
      key.leave(sessions, asked);
    }
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
