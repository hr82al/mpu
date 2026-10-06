/**
 * Подтверждение строки и у владельца в Telegram
 * (`platform/ask-telegram.md`): вопрос `[y/N]` вида `line` строка задаёт
 * своему каналу и — вторым адресатом — владельцу в чате. Кто ответил
 * первым, решает ожидание строки (`line.ts`); здесь — что спросить в чате
 * и как его ответ становится ответом строки.
 */

import {
  type AnswerLine,
  type Asked,
  BUTTONS_ONLY,
  Form,
  ONE,
  type OwnerQuestions,
} from "../botquestions/mod.ts";
import { type CallerEnv, TERMINAL, type Windows } from "../claudehook/mod.ts";
import type { AskKind, ServerFrame } from "../frames/mod.ts";
import { type Line, NO_RIVAL, type Rival, type Rivalry } from "./line.ts";
import type { Asking } from "./prompt.ts";

/** Хвост вопроса-подтверждения: только такой вопрос уходит в чат. */
const CONFIRM_TAIL = /\s*\[y\/N\] $/;

/** Вариант ответа в чате: ответ строке и что сказать о нём. */
interface Choice {
  readonly label: string;
  /** Ответ строке — как кадр `answer` клиента. */
  readonly answer: string;
  /** Последняя строка сообщения. */
  readonly line: string;
  /** Что сказать каналу строки. */
  readonly said: string;
}

const CHOICES: readonly Choice[] = [
  {
    label: "Да",
    answer: "y",
    line: "✅ Да — из чата",
    said: "решено в Telegram — да",
  },
  {
    label: "Нет",
    answer: "n",
    line: "❌ Нет — из чата",
    said: "решено в Telegram — нет",
  },
];

const ANSWER_LINE: AnswerLine = {
  line: (answers) =>
    answers[0].read({
      picked: ([index]) => CHOICES[index].line,
      // Свой текст шаг не принимает (`BUTTONS_ONLY`): ответить им нечем.
      wrote: () => "",
    }),
};

/** Что нужно вопросам в чате одной строки. */
export interface ConfirmParts {
  readonly questions: Pick<OwnerQuestions, "ask">;
  readonly windows: Windows;
  /** Окружение клиента строки: `TMUX`, `TMUX_PANE`. */
  readonly env: CallerEnv;
  /** Голова заголовка: `❓ mpu ask`, у двери агента — с `(MCP)`. */
  readonly head: string;
}

/** Ответ из чата — ответом строке. */
type Decide = (answer: string, said: string) => void;

/** Снятие вопроса в чате: ответ канала строки или его отсутствие. */
type End = (asked: Asked) => void;

/** Где вопрос в чате: ещё не задан, задан или кончился до постановки. */
interface Stage {
  /** Подпись готова: задать вопрос `make`, если ещё есть кому отвечать. */
  ask(make: () => Asked): Stage;
  /** Ожидание строки кончилось. */
  end(end: End): Stage;
  /** Исход вопроса — ответом строке, если ответил владелец. */
  decided(decide: Decide): Promise<void>;
}

/** Ожидание кончилось раньше постановки: в чат ничего не уходит. */
const ENDED: Stage = {
  ask: () => ENDED,
  end: () => ENDED,
  decided: () => Promise.resolve(),
};

/** Вопрос ещё не задан: подпись окна в пути. */
const UNASKED: Stage = {
  ask: (make) => posedIn(make()),
  end: () => ENDED,
  decided: () => Promise.resolve(),
};

/** Вопрос в чате. */
function posedIn(asked: Asked): Stage {
  const stage: Stage = {
    ask: () => stage,
    end: (end) => {
      // У вопроса, уже получившего исход, снятие ничего не меняет.
      end(asked);
      return stage;
    },
    decided: async (decide) => {
      const outcome = await asked.outcome;
      outcome.read({
        answered: (answers) =>
          answers[0].read({
            picked: ([index]) =>
              decide(CHOICES[index].answer, CHOICES[index].said),
            wrote: () => {},
          }),
        withdrawn: () => {},
        expired: () => {},
        // Бот не настроен или недоступен — вопрос только у канала строки.
        refused: () => {},
      });
    },
  };
  return stage;
}

/** Вопрос строки в чате владельца. */
class ChatConfirm implements Rival {
  readonly #parts: ConfirmParts;
  readonly #text: string;

  /** @param text вопрос без хвоста `[y/N]` */
  constructor(parts: ConfirmParts, text: string) {
    this.#parts = parts;
    this.#text = text;
  }

  start(decide: Decide): Rivalry {
    return new ChatRivalry(this.#parts, this.#form(), decide);
  }

  #form(): (places: readonly string[]) => Form {
    const { head } = this.#parts;
    return (places) =>
      new Form({
        places,
        steps: [{
          head,
          text: this.#text,
          options: CHOICES.map((choice) => ({ label: choice.label })),
          choice: ONE,
          reply: BUTTONS_ONLY,
        }],
        answerLine: ANSWER_LINE,
      });
  }
}

/** Идущий вопрос в чате: стадия и её конец. */
class ChatRivalry implements Rivalry {
  #stage: Stage = UNASKED;
  readonly #closed: Promise<void>;

  constructor(
    parts: ConfirmParts,
    form: (places: readonly string[]) => Form,
    decide: Decide,
  ) {
    this.#closed = this.#run(parts, form, decide);
  }

  answered(): void {
    this.#stage = this.#stage.end((asked) => asked.withdraw(TERMINAL));
  }

  lapsed(): void {
    this.#stage = this.#stage.end((asked) => asked.expire());
  }

  closed(): Promise<void> {
    return this.#closed;
  }

  async #run(
    parts: ConfirmParts,
    form: (places: readonly string[]) => Form,
    decide: Decide,
  ): Promise<void> {
    const window = await captionOf(parts);
    this.#stage = this.#stage.ask(() => parts.questions.ask(form(window)));
    await this.#stage.decided(decide);
  }
}

/**
 * Окно клиента в заголовке. Подпись — лишь украшение вопроса: сбой tmux
 * не мешает ни вопросу, ни ответу строки, и подписи тогда просто нет.
 */
async function captionOf(parts: ConfirmParts): Promise<readonly string[]> {
  try {
    return await parts.windows.captionOf(parts.env);
  } catch {
    return [];
  }
}

/** Вопросы в чате одной строки. */
export class ChatConfirms {
  readonly #parts: ConfirmParts;

  constructor(parts: ConfirmParts) {
    this.#parts = parts;
  }

  /**
   * Второй адресат вопроса `text` вида `kind`: только подтверждение —
   * вид `line` и хвост `[y/N] `. Пароль и вопрос с произвольным ответом в
   * чат не уходят никогда (`platform/ask-telegram.md`, «Что не уходит в
   * чат»): это данные вопроса на границе, и решаются они здесь одним
   * местом.
   */
  rival(text: string, kind: AskKind): Rival {
    if (kind !== "line" || !CONFIRM_TAIL.test(text)) return NO_RIVAL;
    return new ChatConfirm(this.#parts, text.replace(CONFIRM_TAIL, ""));
  }
}

/**
 * Строка, чьи вопросы-подтверждения задаются и в чате: канал правил и
 * команда спрашивают её так же, как саму строку.
 */
export class ConfirmingLine implements Asking {
  readonly #line: Line;
  readonly #confirms: ChatConfirms;

  constructor(line: Line, confirms: ChatConfirms) {
    this.#line = line;
    this.#confirms = confirms;
  }

  question(text: string, kind: AskKind = "line"): void {
    this.#line.question(text, kind, this.#confirms.rival(text, kind));
  }

  answer(): Promise<string | undefined> {
    return this.#line.answer();
  }

  deliver(frame: ServerFrame): void {
    this.#line.deliver(frame);
  }
}
