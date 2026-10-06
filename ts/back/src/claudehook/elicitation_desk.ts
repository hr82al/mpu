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
} from "../botquestions/mod.ts";
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

/** Что нужно столу. */
export interface ElicitationParts {
  readonly questions: Pick<OwnerQuestions, "ask" | "post">;
  readonly transcripts: Transcripts;
  readonly windows: Windows;
  /** Срок ожидания владельца. */
  readonly clock: Clock;
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
    const asking: ElicitAsking = {
      ask: (question) => this.#ask(question, env, signal),
      // Не ушло уведомление — ответ хука тот же: решения у формы-ссылки
      // нет в любом случае.
      tell: async (title, body) => {
        await this.#parts.questions.post(titled(title, body));
      },
    };
    return elicitationOf(text).reply(asking);
  }

  async #ask(
    question: ElicitQuestion,
    env: CallerEnv,
    signal: AbortSignal,
  ): Promise<HookReply> {
    const { questions, transcripts, windows, clock } = this.#parts;
    // Транскрипт здесь только называет сессию: признак ответа в
    // терминале не нужен — форма в терминале закрыта, пока хук идёт.
    const title = await question.title.title(async (path) =>
      (await transcripts.read(path, TYPED_INPUT)).title()
    );
    const window = await windows.captionOf(env);
    const asked = questions.ask(
      question.form(placesOf(title, question.project, window)),
    );
    const gone = AbortSignal.any([signal, this.#closing.signal]);
    const outcome = await settledWithin(asked, gone, clock, () => []);
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
  clock: REAL_CLOCK,
});
