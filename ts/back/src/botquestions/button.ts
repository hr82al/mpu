/**
 * Кнопки вопроса: подпись под пределом и данные нажатия
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение», «Ответы
 * владельца»). Данные несут метку запуска ядра, номер вопроса и ключ
 * кнопки: нажатие кнопки прошлого запуска или прошлого вопроса узнаётся
 * по ним, без памяти о показанных сообщениях.
 */

/** Подсказки подтверждения нажатия. */
export const ACCEPTED = "";
export const STALE = "вопрос уже решён";
export const NONE_MARKED = "отметьте хотя бы один вариант";
export const NOTHING_ELSE = "больше ничего не ждёт";

/** Предел подписи варианта, символов. */
const LABEL_LIMIT = 60;

/**
 * Подпись не длиннее 60 символов: длиннее — 59 и `…`. Символ — кодовая
 * точка: суррогатная пара не рвётся пополам.
 */
export function clipLabel(label: string): string {
  const points = Array.from(label);
  if (points.length <= LABEL_LIMIT) return label;
  return `${points.slice(0, LABEL_LIMIT - 1).join("")}…`;
}

/** Что делает шаг с нажатием (см. `form.ts`). */
export interface StepPressable {
  /** Нажат вариант `index`; ответ — подсказка подтверждения. */
  pick(index: number): string;
  /** Нажато `Готово`. */
  done(): string;
}

/**
 * Что делает вопрос с нажатием: кнопки шага и кнопки-действия вопроса
 * (`platform/telegram-questions.md`, «R2»).
 */
export interface Pressable extends StepPressable {
  /** Нажато «отложить» (`Позже`). */
  later(): string;
  /** Нажато «снять» (`Пропустить`). */
  skip(): string;
}

/** Ключ кнопки: вариант или `Готово`. */
export interface Key {
  /** Запись ключа в данных кнопки. */
  readonly code: string;
  pressOn(step: Pressable): string;
}

/** Кнопка варианта `index`. */
export class OptionKey implements Key {
  readonly #index: number;

  constructor(index: number) {
    this.#index = index;
  }

  get code(): string {
    return String(this.#index);
  }

  pressOn(step: Pressable): string {
    return step.pick(this.#index);
  }
}

/** Кнопка `Готово` у шага «несколько». */
export const DONE: Key = {
  code: "ok",
  pressOn: (step) => step.done(),
};

/** Кнопка вида «отложить»: вопрос — в конец своего вида. */
export const LATER_KEY: Key = {
  code: "later",
  pressOn: (question) => question.later(),
};

/** Кнопка вида «снять»: исход «снят». */
export const SKIP_KEY: Key = {
  code: "skip",
  pressOn: (question) => question.skip(),
};

/** Кнопка шага: подпись и ключ. */
export interface Button {
  readonly label: string;
  readonly key: Key;
}

/** Данные нажатия, разобранные из `callback_data`. */
export interface Press {
  /**
   * Нажатие шага `step` вопроса `number` запуска `run` доходит до шага;
   * прочее — `вопрос уже решён`. Шаг — в данных, потому что сообщение
   * многошагового вопроса одно: повтор нажатия шага 1 не должен ответить
   * шаг 2 вариантом, которого владелец не видел.
   */
  pressOn(
    run: string,
    number: number,
    step: number,
    pressable: Pressable,
  ): string;
}

/** Ключи кнопок, кроме вариантов, — по записи в данных. */
const NAMED_KEYS: readonly Key[] = [DONE, LATER_KEY, SKIP_KEY];

/**
 * Разбор — `<запуск>:<номер>:<шаг>:<ключ>`; метка запуска — `[a-z0-9]+`,
 * шаг — с нуля, ключ — запись ключа из `NAMED_KEYS` или номер варианта.
 */
const DATA = new RegExp(
  `^([a-z0-9]+):(\\d{1,16}):(\\d):(${NAMED_KEYS.map((key) => key.code).join(
    "|",
  )}|\\d{1,3})$`,
);

/** Данные кнопки этого ядра. */
export class ButtonData implements Press {
  readonly #run: string;
  readonly #number: number;
  readonly #step: number;
  readonly #key: Key;

  constructor(run: string, number: number, step: number, key: Key) {
    this.#run = run;
    this.#number = number;
    this.#step = step;
    this.#key = key;
  }

  /** Разбирает `callback_data`; чужое или битое — `NOT_OURS`. */
  static parse(data: string): Press {
    const match = DATA.exec(data);
    if (match === null) return NOT_OURS;
    const [, run, number, step, code] = match;
    const key =
      NAMED_KEYS.find((named) => named.code === code) ??
      new OptionKey(Number(code));
    return new ButtonData(run, Number(number), Number(step), key);
  }

  /** Запись в `callback_data`; не длиннее 64 байт (предел Telegram). */
  toString(): string {
    return `${this.#run}:${this.#number}:${this.#step}:${this.#key.code}`;
  }

  pressOn(
    run: string,
    number: number,
    step: number,
    pressable: Pressable,
  ): string {
    if (run !== this.#run || number !== this.#number || step !== this.#step) {
      return STALE;
    }
    return this.#key.pressOn(pressable);
  }
}

/** Данные, которых это ядро не выпускало. */
const NOT_OURS: Press = { pressOn: () => STALE };
