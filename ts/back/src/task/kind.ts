/**
 * Виды сообщений канала и ход проекта (`task.md`, «Виды сообщений»,
 * «Вывод»). Ход не хранится: его выводит свёртка журнала, где каждый вид
 * сам отвечает, как он меняет ход.
 */

/** Чей ход: неизменяемый, каждый вид даёт следующий. */
export class Turn {
  readonly #base: string;
  readonly #ownerOpen: boolean;

  /**
   * @param base ход без владельца: `ждёт исполнителя`, `ждёт хоста`, `-`
   * @param ownerOpen открыт ли `owner` без ответа — важнее базы
   */
  constructor(base: string, ownerOpen: boolean) {
    this.#base = base;
    this.#ownerOpen = ownerOpen;
  }

  /** Ход переходит к `base`; открытый вопрос владельцу остаётся. */
  to(base: string): Turn {
    return new Turn(base, this.#ownerOpen);
  }

  /** Вопрос владельцу открыт (`owner`) или закрыт (`owner-answer`). */
  owner(open: boolean): Turn {
    return new Turn(this.#base, open);
  }

  label(): string {
    return this.#ownerOpen ? "ждёт владельца" : this.#base;
  }
}

/** Хода нет: журнал пуст. */
export const NO_TURN: Turn = new Turn("-", false);

const EXECUTOR = "ждёт исполнителя";
const HOST = "ждёт хоста";

/** Вид сообщения: слово журнала и действие на ход. */
export interface Kind {
  readonly word: string;
  after(turn: Turn): Turn;
}

/** Вид, не меняющий хода: решение и правило. */
function passing(word: string): Kind {
  return { word, after: (turn) => turn };
}

function handing(word: string, base: string): Kind {
  return { word, after: (turn) => turn.to(base) };
}

function owning(word: string, open: boolean): Kind {
  return { word, after: (turn) => turn.owner(open) };
}

export const TASK: Kind = handing("task", EXECUTOR);
export const REPORT: Kind = handing("report", HOST);
export const QUESTION: Kind = handing("question", HOST);
export const ANSWER: Kind = handing("answer", EXECUTOR);
export const DECISION: Kind = passing("decision");
export const OWNER: Kind = owning("owner", true);
export const OWNER_ANSWER: Kind = owning("owner-answer", false);
export const RULE: Kind = passing("rule");

/** Все виды в порядке таблицы спеки: так их перечисляет отказ. */
export const KINDS: readonly Kind[] = [
  TASK,
  REPORT,
  QUESTION,
  ANSWER,
  DECISION,
  OWNER,
  OWNER_ANSWER,
  RULE,
];

/** Виды, которые собирает `decisions` в порциях. */
export const DECIDING: readonly Kind[] = [DECISION, OWNER, OWNER_ANSWER];

/** Слово `kind:` не из видов канала. */
export class UnknownKind extends Error {
  override name = "UnknownKind";
}

/**
 * Вид по слову (граница: ключ `kind:` и строка журнала).
 *
 * @throws UnknownKind — слово не вид; текст — готовый отказ
 */
export function kindNamed(word: string): Kind {
  const kind = KINDS.find((one) => one.word === word);
  if (kind !== undefined) return kind;
  const known = KINDS.map((one) => one.word).join(", ");
  throw new UnknownKind(`неизвестный вид ${word} — допустимо: ${known}`);
}
