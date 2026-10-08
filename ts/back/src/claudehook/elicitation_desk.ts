/**
 * Вопрос хука `Elicitation` в ядре (`claude-hook-elicitation.md`): payload
 * → форма владельцу → решение. Терминальная форма закрыта, пока хук
 * работает, поэтому ответа в терминале не бывает: исход — ответ из чата,
 * срок ядра или обрыв строки.
 */

import {
  type Clock,
  NO_BOT,
  type OwnerQuestions,
  REAL_CLOCK,
  titled,
} from "@mpu/cmd-botquestions";
import { EXPIRED } from "./decision.ts";
import { settledWithin } from "./desk.ts";
import {
  type ElicitAsking,
  elicitationOf,
  type ElicitQuestion,
  IN_TERMINAL,
  NoAnswer,
} from "./elicitation.ts";
import { placesOf } from "./places.ts";
import type { HookReply } from "./reply.ts";
import { NO_TRANSCRIPTS, type Transcripts, TYPED_INPUT } from "./transcript.ts";
import { type CallerEnv, NO_WINDOWS, type Windows } from "./window.ts";
import { heldWhile, sessionKeyOf, Sessions } from "./sessions.ts";

/** Что нужно столу. */
export interface ElicitationParts {
  readonly questions: Pick<OwnerQuestions, "ask" | "post">;
  readonly transcripts: Transcripts;
  readonly windows: Windows;
  /** Сессии Claude Code: форма — срочный вопрос своей сессии. */
  readonly sessions: Sessions;
  /** Срок ожидания владельца. */
  readonly clock: Clock;
  /** Строка в журнал службы: отказ уведомления формы-ссылки. */
  readonly diagnose: (line: string) => void;
}

/** Вопросы хука `Elicitation`. */
export class ElicitationDesk {
  readonly #parts: ElicitationParts;
  /** Остановка ядра: ждущие вопросы и пришедшие после — «истёк». */
  readonly #closing = new AbortController();

  constructor(parts: ElicitationParts) {
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
    // Форма — следующее событие сессии: её висящий вопрос о праве решён в
    // терминале (право на MCP-тул одобрено, тул показал форму).
    sessionKeyOf(env).movedOn(this.#parts.sessions);
    const asking: ElicitAsking = {
      ask: (question) => this.#ask(question, env, signal),
      // Не ушло уведомление — ответ хука тот же (решения у формы-ссылки
      // нет в любом случае), а причина — в журнал службы.
      tell: async (title, body) => {
        const posted = await this.#parts.questions.post(titled(title, body));
        posted.read({
          sent: () => {},
          refused: (reason) =>
            this.#parts.diagnose(`claude-hook elicitation: ${reason}`),
        });
      },
    };
    return elicitationOf(text).reply(asking);
  }

  async #ask(
    question: ElicitQuestion,
    env: CallerEnv,
    signal: AbortSignal,
  ): Promise<HookReply> {
    const { questions, transcripts, windows, sessions, clock } = this.#parts;
    // Транскрипт здесь только называет сессию: признак ответа в
    // терминале не нужен — форма в терминале закрыта, пока хук идёт.
    const title = await question.title.title(async (path) =>
      (await transcripts.read(path, TYPED_INPUT)).title(),
    );
    const window = await windows.captionOf(env);
    const key = sessionKeyOf(env);
    const asked = key.seatUrgent(sessions, () =>
      questions.ask(question.form(placesOf(title, question.project, window))),
    );
    const gone = AbortSignal.any([signal, this.#closing.signal]);
    const outcome = await heldWhile(key, sessions, asked, () =>
      settledWithin(asked, gone, clock, () => []),
    );
    return outcome.read({
      answered: (answers) => question.decide(answers),
      withdrawn: () => new NoAnswer(IN_TERMINAL),
      expired: () => new NoAnswer(EXPIRED),
      refused: (reason) => new NoAnswer(reason),
    });
  }
}

/** Стол без бота: вопрос — отказ «бот не настроен», файлов не читает. */
export const NO_ELICITATION_DESK = new ElicitationDesk({
  questions: NO_BOT,
  transcripts: NO_TRANSCRIPTS,
  windows: NO_WINDOWS,
  sessions: new Sessions(REAL_CLOCK),
  clock: REAL_CLOCK,
  // Без бота уведомлений нет: и отказа писать некуда и незачем.
  diagnose: () => {},
});
