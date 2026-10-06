/**
 * Вопросы «ждёт ввода» хука `Stop` в ядре (`claude-hook-stop.md`):
 * payload → сообщение в чате → хук выходит сразу. Вопрос живёт дольше
 * строки хука: его держит стол — вместе с наблюдателем транскрипта и
 * ключом сессии, — пока не придёт исход: ввод в терминале, новый
 * конец хода той же сессии, `Пропустить` или остановка ядра.
 */

import {
  type Asked,
  NO_BOT,
  type OutcomeReader,
  type OwnerQuestions,
} from "../botquestions/mod.ts";
import { TERMINAL } from "./decision.ts";
import { placesOf } from "./places.ts";
import { type HookReply, unparsedInput } from "./reply.ts";
import { type SessionKey, sessionKeyOf, Sessions } from "./sessions.ts";
import {
  CONTINUING,
  NO_CHANNEL,
  NoQuestion,
  QUIET,
  stopPayloadOf,
  type StopRequest,
  waitingForm,
} from "./stop.ts";
import {
  NO_TRANSCRIPTS,
  type Transcript,
  type Transcripts,
  TYPED_INPUT,
} from "./transcript.ts";
import { type CallerEnv, NO_WINDOWS, type Windows } from "./window.ts";

/** Что нужно столу. */
export interface StopDeskParts {
  readonly questions: Pick<OwnerQuestions, "ask">;
  readonly transcripts: Transcripts;
  readonly windows: Windows;
  /** Сессии по ключу: общие с каналами ядра. */
  readonly sessions: Sessions;
  /** Строка в журнал службы: сбой наблюдателя, которому некого винить. */
  readonly diagnose: (line: string) => void;
}

/**
 * Исход, пришедший раньше постановки, → ответ хука: показать не удалось —
 * причина; прочее (снят, истёк) — вопрос был поставлен.
 */
const PLACING: OutcomeReader<HookReply> = {
  answered: () => QUIET,
  withdrawn: () => QUIET,
  expired: () => QUIET,
  refused: (reason) => new NoQuestion(reason),
};

/**
 * Работа до исхода: решилась — `then`; прервана — не сбой, её просто
 * больше не ждут.
 */
function until(
  stop: AbortSignal,
  work: Promise<void>,
  then: () => void,
): Promise<void> {
  return work.then(then, (err) => {
    if (!stop.aborted) throw err;
  });
}

/** Вопросы «ждёт ввода». */
export class StopDesk {
  readonly #parts: StopDeskParts;
  /** Остановка ядра: ждущие вопросы и пришедшие после — «истёк». */
  readonly #closing = new AbortController();
  /** Наблюдения вопросов до исхода. */
  readonly #watching = new Set<Promise<void>>();

  constructor(parts: StopDeskParts) {
    this.#parts = parts;
  }

  /**
   * Ответ хука на stdin `text`: вопрос поставлен — тишина; нет — причина.
   *
   * @param env окружение клиента хука: `TMUX`, `TMUX_PANE`,
   *   `CLAUDE_CODE_MESSAGING_SOCKET`
   */
  reply(text: string, env: CallerEnv): Promise<HookReply> {
    return stopPayloadOf(text).read({
      unparsed: (what) => Promise.resolve(new NoQuestion(unparsedInput(what))),
      continuing: () => Promise.resolve(new NoQuestion(CONTINUING)),
      parsed: (request) => this.#ask(request, env),
    });
  }

  /** Остановка ядра: вопросы — в «истёк», наблюдатели дождались конца. */
  async stop(): Promise<void> {
    this.#closing.abort();
    await Promise.all(this.#watching);
  }

  async #ask(request: StopRequest, env: CallerEnv): Promise<HookReply> {
    const { questions, transcripts, windows } = this.#parts;
    const transcript = await request.transcript.read(transcripts, TYPED_INPUT);
    const window = await windows.captionOf(env);
    const places = placesOf(transcript.title(), request.project, window);
    const form = waitingForm(places, request.message, NO_CHANNEL);
    const key = sessionKeyOf(env);
    const asked = key.seat(this.#parts.sessions, () => questions.ask(form));
    this.#watch(asked, transcript, key);
    // Хук не ждёт владельца: только постановки. Отказ показа решается
    // внутри той же перерисовки, что и постановка, — раньше неё; у бота
    // без ключей оба решены сразу, и первым идёт исход.
    return await Promise.race([
      asked.outcome.then((outcome) => outcome.read(PLACING)),
      asked.placed.then(() => QUIET),
    ]);
  }

  /** Наблюдение вопроса до исхода — во владении стола. */
  #watch(asked: Asked, transcript: Transcript, key: SessionKey): void {
    const watching = this.#watched(asked, transcript).finally(() => {
      key.leave(this.#parts.sessions, asked);
      this.#watching.delete(watching);
    });
    this.#watching.add(watching);
  }

  /**
   * Ждёт исход; транскрипт снимает вопрос «решено в терминале», остановка
   * ядра — «истёк». После исхода наблюдатель гаснет, и его конец
   * дожидается — висящих таймеров и чтений не остаётся.
   */
  async #watched(asked: Asked, transcript: Transcript): Promise<void> {
    const done = new AbortController();
    const closing = this.#closing.signal;
    const stop = AbortSignal.any([closing, done.signal]);
    const expire = () => asked.expire();
    closing.addEventListener("abort", expire, {
      once: true,
      signal: done.signal,
    });
    if (closing.aborted) expire();
    const watching = until(
      stop,
      transcript.answered(stop),
      () => asked.withdraw(TERMINAL),
    ).catch((err) => {
      // Хук уже вышел — сбой наблюдателя некому отдать: вопрос остаётся,
      // его снимут чат, новый конец хода или остановка ядра.
      this.#parts.diagnose(`claude-hook stop: наблюдатель: ${String(err)}`);
    });
    // Исход у вопроса бывает всегда: промис исхода не отвергается.
    await asked.outcome;
    done.abort();
    await watching;
  }
}

/** Стол без бота: вопрос — отказ «бот не настроен», файлов не читает. */
export const NO_STOP_DESK = new StopDesk({
  questions: NO_BOT,
  transcripts: NO_TRANSCRIPTS,
  windows: NO_WINDOWS,
  sessions: new Sessions(),
  diagnose: () => {},
});
