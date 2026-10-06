/**
 * Вопрос хука `PermissionRequest` в ядре (`claude-hook-permission-request.md`,
 * «Ожидание», «Срок», «Решено в другом месте»): payload → вопрос
 * владельцу → решение. Исход приходит первым из четырёх: ответ из чата,
 * ответ в терминале (транскрипт), срок ядра, обрыв строки.
 */

import {
  type Asked,
  type Clock,
  NO_BOT,
  type Outcome,
  type OutcomeReader,
  type OwnerQuestions,
  REAL_CLOCK,
} from "../botquestions/mod.ts";
import { EXPIRED, NoDecision, TERMINAL } from "./decision.ts";
import {
  type Asking,
  permissionPayloadOf,
  type PermissionRequest,
} from "./permission.ts";
import { type HookReply, unparsedInput } from "./reply.ts";
import { type Transcript, Transcripts } from "./transcript.ts";
import { type CallerEnv, NO_WINDOWS, type Windows } from "./window.ts";

/** Срок хука во фрагменте настроек, секунды [D.6]. */
export const HOOK_TIMEOUT_S = 3600;

/**
 * Срок ядра: на минуту раньше срока хука — ядро успевает само поправить
 * сообщение в «истёк», прежде чем Claude Code снимет хук.
 */
export const DEADLINE_MS = (HOOK_TIMEOUT_S - 60) * 1000;

/** Что нужно столу. */
export interface DeskParts {
  readonly questions: Pick<OwnerQuestions, "ask">;
  readonly transcripts: Transcripts;
  readonly windows: Windows;
  /** Срок и опрос транскрипта. */
  readonly clock: Clock;
}

/** Исход вопроса → ответ хука. */
function replyOf(asking: Asking): OutcomeReader<HookReply> {
  return {
    answered: (answers) => asking.decide(answers),
    withdrawn: () => new NoDecision(TERMINAL),
    expired: () => new NoDecision(EXPIRED),
    refused: (reason) => new NoDecision(reason),
  };
}

/**
 * Работа до исхода: решилась — `then`; прервана остановкой — не сбой,
 * её просто больше не ждут.
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

/** Вопросы хука `PermissionRequest`. */
export class PermissionDesk {
  readonly #parts: DeskParts;
  /** Остановка ядра: ждущие вопросы и пришедшие после — «истёк». */
  readonly #closing = new AbortController();

  constructor(parts: DeskParts) {
    this.#parts = parts;
  }

  /** Остановка ядра: никто больше не ждёт владельца. */
  stop(): void {
    this.#closing.abort();
  }

  /**
   * Ответ хука на stdin `text`.
   *
   * @param env окружение клиента хука: `TMUX`, `TMUX_PANE`
   * @param signal обрыв строки — исход «истёк»
   */
  reply(text: string, env: CallerEnv, signal: AbortSignal): Promise<HookReply> {
    return permissionPayloadOf(text).read({
      unparsed: (what) => Promise.resolve(new NoDecision(unparsedInput(what))),
      parsed: (request) => this.#ask(request, env, signal),
    });
  }

  async #ask(
    request: PermissionRequest,
    env: CallerEnv,
    signal: AbortSignal,
  ): Promise<HookReply> {
    const { questions, transcripts, windows } = this.#parts;
    const transcript = await transcripts.read(
      request.transcriptPath,
      request.call,
    );
    const window = await windows.captionOf(env);
    const places = [...transcript.title(), ...request.project, ...window];
    const asked = questions.ask(request.asking.form(places));
    // Строка, оборванная раньше постановки, истекает тут же: ряд убирает
    // непоказанный вопрос молча, в чат ничего не уходит.
    const gone = AbortSignal.any([signal, this.#closing.signal]);
    const outcome = await this.#settled(asked, transcript, gone);
    return outcome.read(replyOf(request.asking));
  }

  /**
   * Исход вопроса; после него наблюдатель транскрипта и срок гаснут, и их
   * конец дожидается — висящих таймеров и чтений не остаётся. `signal` —
   * обрыв строки или остановка ядра: исход «истёк».
   */
  async #settled(
    asked: Asked,
    transcript: Transcript,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const done = new AbortController();
    const stop = AbortSignal.any([signal, done.signal]);
    const expire = () => asked.expire();
    signal.addEventListener("abort", expire, {
      once: true,
      signal: done.signal,
    });
    if (signal.aborted) expire();
    // Обработчики — сразу: отказ, пришедший до конца ожидания, иначе
    // успел бы стать необработанным.
    const watching = Promise.allSettled([
      until(stop, transcript.answered(stop), () => asked.withdraw(TERMINAL)),
      until(stop, this.#parts.clock.pause(DEADLINE_MS, stop), expire),
    ]);
    // Исход у вопроса бывает всегда: промис исхода не отвергается.
    const outcome = await asked.outcome;
    done.abort();
    for (const result of await watching) {
      if (result.status === "rejected") throw result.reason;
    }
    return outcome;
  }
}

/** Стол без бота: вопрос — отказ «бот не настроен», файлов не читает. */
export const NO_DESK = new PermissionDesk({
  questions: NO_BOT,
  transcripts: new Transcripts({
    files: {
      read: () => Promise.reject(new Deno.errors.NotFound("транскриптов нет")),
      readFrom: () =>
        Promise.reject(new Deno.errors.NotFound("транскриптов нет")),
    },
    clock: REAL_CLOCK,
  }),
  windows: NO_WINDOWS,
  clock: REAL_CLOCK,
});
