/**
 * Форма вопроса — то, что потребитель передаёт ядру
 * (`docs/specs/platform/telegram-questions.md`, «Форма вопроса и
 * исход»). Ядро не знает, откуда вопрос: новый вид вопроса — новые
 * данные формы, а не правка здесь.
 */

import {
  ACCEPTED,
  type Button,
  clipLabel,
  DONE,
  LATER_KEY,
  NONE_MARKED,
  OptionKey,
  type Pressable,
  SKIP_KEY,
  STALE,
  type StepPressable,
} from "./button.ts";
import type { Clip, Markup } from "./card.ts";
import {
  type AnswerLine,
  CHECKED,
  Picked,
  type StepAnswer,
  Written,
} from "./outcome.ts";
import { type Kind, URGENT } from "./row.ts";

/** Вариант ответа. */
export interface Option {
  readonly label: string;
  /** Описание; есть хоть у одного варианта — варианты перечислены строками. */
  readonly description?: string;
}

/**
 * Заголовок: голова шага (значок и имя, `🔐 Bash`) и места формы
 * (`ozon`, `w:2 claude`) — `🔐 Bash — mpu-bot · ozon`. Голова — у шага:
 * у AskUserQuestion из нескольких вопросов у каждого свой `header`; номер
 * шага встаёт после головы, до мест.
 */
export class Title {
  readonly #places: readonly string[];

  constructor(places: readonly string[]) {
    this.#places = [...places];
  }

  /**
   * Строка заголовка шага `step` (с 1) из `steps` с головой `head`: мест
   * нет — нет и разделителя ` — `.
   */
  line(head: string, step: number, steps: number): string {
    const numbered = steps > 1 ? `${head} ${step}/${steps}` : head;
    return [numbered, this.#places.join(" · ")].filter((part) => part !== "")
      .join(" — ");
  }
}

/** Что шаг делает с ответом: его слушает вопрос. */
export interface StepEvents {
  /** Шаг отвечен. */
  answered(answer: StepAnswer): void;
  /** Ответа нет, но кнопки шага изменились. */
  changed(): void;
}

/** Идущий шаг: память отметок и кнопки. */
export interface Selection {
  /** Нажатие кнопки; ответ — подсказка подтверждения. */
  press(events: StepEvents): StepPressable;
  /** Кнопки по рядам. */
  buttons(): readonly (readonly Button[])[];
}

/** Вид выбора шага. */
export interface Choice {
  start(options: readonly Option[]): Selection;
}

/** Кнопки по две в ряд. */
function pairs(buttons: readonly Button[]): readonly (readonly Button[])[] {
  const rows: Button[][] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}

/** Есть ли вариант с номером `index`. */
function within(options: readonly Option[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < options.length;
}

class OneSelection implements Selection {
  readonly #options: readonly Option[];

  constructor(options: readonly Option[]) {
    this.#options = options;
  }

  press(events: StepEvents): StepPressable {
    return {
      pick: (index) => {
        if (!within(this.#options, index)) return STALE;
        events.answered(new Picked([index], [this.#options[index].label]));
        return ACCEPTED;
      },
      // `Готово` у одного выбора не показывается: такое нажатие — чужое.
      done: () => STALE,
    };
  }

  buttons(): readonly (readonly Button[])[] {
    return pairs(this.#options.map((option, index) => ({
      label: clipLabel(option.label),
      key: new OptionKey(index),
    })));
  }
}

class ManySelection implements Selection {
  readonly #options: readonly Option[];
  readonly #marked = new Set<number>();

  constructor(options: readonly Option[]) {
    this.#options = options;
  }

  press(events: StepEvents): StepPressable {
    return {
      pick: (index) => {
        if (!within(this.#options, index)) return STALE;
        if (!this.#marked.delete(index)) this.#marked.add(index);
        events.changed();
        return ACCEPTED;
      },
      done: () => {
        if (this.#marked.size === 0) return NONE_MARKED;
        const indices = [...this.#marked].sort((a, b) => a - b);
        const labels = indices.map((index) => this.#options[index].label);
        events.answered(new Picked(indices, labels));
        return ACCEPTED;
      },
    };
  }

  buttons(): readonly (readonly Button[])[] {
    const options = this.#options.map((option, index) => ({
      label: `${this.#marked.has(index) ? "☑" : "☐"} ${
        clipLabel(option.label)
      }`,
      key: new OptionKey(index),
    }));
    return [...pairs(options), [{ label: "Готово", key: DONE }]];
  }
}

/** Один вариант: нажатие отвечает шаг. */
export const ONE: Choice = { start: (options) => new OneSelection(options) };

/** Несколько: нажатие отмечает, `Готово` отвечает. */
export const MANY: Choice = { start: (options) => new ManySelection(options) };

/** Что сказать владельцу в ответ на его текст. */
export interface Notice {
  deliver(say: (text: string) => Promise<void>): Promise<void>;
}

/** Ответа владельцу нет. */
export const SILENT: Notice = { deliver: () => Promise.resolve() };

/** Ответ владельцу текстом `text`. */
export function notice(text: string): Notice {
  return { deliver: (say) => say(text) };
}

/** Принимается ли текст владельца ответом шага. */
export interface TextRule {
  write(text: string, events: StepEvents): Notice;
}

/** Текст — ответ шага. */
export const TAKES_TEXT: TextRule = {
  write: (text, events) => {
    events.answered(new Written(text));
    return SILENT;
  },
};

/** Шаг отвечается только кнопкой. */
export const BUTTONS_ONLY: TextRule = {
  write: () => notice("ответьте кнопкой"),
};

/** Шаг формы. */
export interface Step {
  /** Голова заголовка шага: значок и имя (`❓ Размер`). */
  readonly head: string;
  /**
   * Строки тела под заголовком. Перечитываются при каждой перерисовке:
   * потребитель с живым текстом (снимок окна) отдаёт его свойством и зовёт
   * `StepEvents.changed`.
   */
  readonly text: string;
  readonly options: readonly Option[];
  readonly choice: Choice;
  readonly reply: TextRule;
  /**
   * Какой конец текста остаётся при усечении; не сказано — умолчание
   * тела (`Card`): начало.
   */
  readonly clip?: Clip;
  /** Как выделить текст в сообщении; не сказано — без выделений. */
  readonly markup?: Markup;
}

/** Что делают кнопки-действия вопроса. */
export type ActionPress = Pick<Pressable, "later" | "skip">;

/** Кнопка вида «отложить» — вопрос в конец своего вида. */
export const LATER: Button = { label: "Позже", key: LATER_KEY };

/** Кнопка вида «снять» — исход «снят», `⏭ пропущено`. */
export const SKIP: Button = { label: "Пропустить", key: SKIP_KEY };

/** Сколько шагов бывает у формы. */
const MAX_STEPS = 4;

/** Форма вопроса. */
export class Form {
  readonly title: Title;
  readonly steps: readonly Step[];
  readonly answerLine: AnswerLine;
  /** Вид вопроса: его место в ряду. */
  readonly kind: Kind;
  readonly #actions: readonly Button[];

  /** @throws RangeError — шагов нет или больше четырёх */
  constructor(options: {
    /** Места заголовка по порядку: сессия, проект, окно. */
    readonly places: readonly string[];
    readonly steps: readonly Step[];
    /** Строка ответа; не сказано — `CHECKED`. */
    readonly answerLine?: AnswerLine;
    /** Вид вопроса; не сказано — `URGENT`. */
    readonly kind?: Kind;
    /** Кнопки-действия под кнопками шага (`LATER`, `SKIP`). */
    readonly actions?: readonly Button[];
  }) {
    if (options.steps.length === 0 || options.steps.length > MAX_STEPS) {
      throw new RangeError(
        `у формы 1–${MAX_STEPS} шага, передано ${options.steps.length}`,
      );
    }
    this.title = new Title(options.places);
    this.steps = [...options.steps];
    this.answerLine = options.answerLine ?? CHECKED;
    this.kind = options.kind ?? URGENT;
    this.#actions = [...(options.actions ?? [])];
  }

  /** Ряды кнопок-действий: по две в ряд. */
  actionRows(): readonly (readonly Button[])[] {
    return pairs(this.#actions);
  }

  /**
   * Нажатия кнопок-действий: то, что форма предлагает, делает `act`;
   * не предложенное (данные кнопки, которой у вопроса нет) — `вопрос уже
   * решён`.
   */
  actionPress(act: ActionPress): ActionPress {
    const offered = (button: Button, press: () => string) =>
      this.#actions.includes(button) ? press : () => STALE;
    return {
      later: offered(LATER, () => act.later()),
      skip: offered(SKIP, () => act.skip()),
    };
  }
}
