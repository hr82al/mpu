/**
 * Ответ шага и исход вопроса (`docs/specs/platform/telegram-questions.md`,
 * «Форма вопроса и исход»). Исход сам даёт последнюю строку сообщения и
 * сам рассказывает потребителю, чем кончился, — потребитель не
 * различает виды проверками.
 */

/** Чтение ответа шага потребителем. */
export interface StepAnswerReader<T> {
  /** Выбраны варианты: номера по возрастанию (один выбор — один номер). */
  picked(indices: readonly number[]): T;
  /** Владелец ответил своим текстом. */
  wrote(text: string): T;
}

/** Ответ одного шага. */
export interface StepAnswer {
  read<T>(reader: StepAnswerReader<T>): T;
  /** Подписи выбранного через `, ` либо текст — для строки исхода. */
  summary(): string;
}

/** Ответ кнопкой (кнопками). */
export class Picked implements StepAnswer {
  readonly #indices: readonly number[];
  readonly #labels: readonly string[];

  constructor(indices: readonly number[], labels: readonly string[]) {
    this.#indices = [...indices];
    this.#labels = [...labels];
  }

  read<T>(reader: StepAnswerReader<T>): T {
    return reader.picked([...this.#indices]);
  }

  summary(): string {
    return this.#labels.join(", ");
  }
}

/** Ответ текстом владельца. */
export class Written implements StepAnswer {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  read<T>(reader: StepAnswerReader<T>): T {
    return reader.wrote(this.#text);
  }

  summary(): string {
    return this.#text;
  }
}

/**
 * Строка ответа под сообщением: значок и текст задаёт потребитель
 * (у права `No` — `❌`); умолчание — `CHECKED`.
 */
export interface AnswerLine {
  line(answers: readonly StepAnswer[]): string;
}

/**
 * `✅ <ответ> — из чата`. Ответы нескольких шагов — через `; `: спека
 * строку многошагового ответа не задаёт, а подписи внутри шага уже
 * разделены `, `.
 */
export const CHECKED: AnswerLine = {
  line: (answers) =>
    `✅ ${answers.map((answer) => answer.summary()).join("; ")} — из чата`,
};

/** Чтение исхода потребителем. */
export interface OutcomeReader<T> {
  /** Ответ по каждому шагу, после последнего шага. */
  answered(answers: readonly StepAnswer[]): T;
  /** Потребитель сам снял вопрос. */
  withdrawn(): T;
  /** Потребитель отключился, вышел срок или ядро перезапущено. */
  expired(): T;
  /** Вопрос не удалось показать; причина — для человека. */
  refused(reason: string): T;
}

/** Исход вопроса — ровно один. */
export interface Outcome {
  read<T>(reader: OutcomeReader<T>): T;
  /** Последняя строка сообщения после исхода. */
  line(): string;
}

/** Строка истёкшего вопроса — одна на исход и на перезапуск ядра. */
export const EXPIRED_LINE = "⌛ истёк — ответьте в терминале";

/** Ответ владельца. */
export class Answered implements Outcome {
  readonly #answers: readonly StepAnswer[];
  readonly #line: AnswerLine;

  constructor(answers: readonly StepAnswer[], line: AnswerLine) {
    this.#answers = [...answers];
    this.#line = line;
  }

  read<T>(reader: OutcomeReader<T>): T {
    return reader.answered([...this.#answers]);
  }

  line(): string {
    return this.#line.line(this.#answers);
  }
}

/** Снят потребителем: текст снятия — его. */
export class Withdrawn implements Outcome {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  read<T>(reader: OutcomeReader<T>): T {
    return reader.withdrawn();
  }

  line(): string {
    return `✅ ${this.#text}`;
  }
}

/**
 * Снят потребителем с последней строкой целиком (`⌛ сессия закрыта`):
 * для потребителя — то же снятие, значок строки — его.
 */
export class WithdrawnAs implements Outcome {
  readonly #line: string;

  constructor(line: string) {
    this.#line = line;
  }

  read<T>(reader: OutcomeReader<T>): T {
    return reader.withdrawn();
  }

  line(): string {
    return this.#line;
  }
}

/**
 * Снят владельцем кнопкой «Пропустить»: для потребителя — то же снятие,
 * строка своя. Памяти нет — один экземпляр.
 */
export const SKIPPED: Outcome = {
  read: (reader) => reader.withdrawn(),
  line: () => "⏭ пропущено",
};

/** Истёк; памяти нет — один экземпляр. */
export const EXPIRED: Outcome = {
  read: (reader) => reader.expired(),
  line: () => EXPIRED_LINE,
};

/** Вопрос не показан: сообщения с кнопками по нему нет. */
export class Refused implements Outcome {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  read<T>(reader: OutcomeReader<T>): T {
    return reader.refused(this.#reason);
  }

  /**
   * Отказ бывает только у непоказанного вопроса, и строка в чат не
   * уходит; для полноты протокола — строка истёкшего: если бы сообщение
   * было, ответить на него из чата уже нельзя.
   */
  line(): string {
    return EXPIRED_LINE;
  }
}
