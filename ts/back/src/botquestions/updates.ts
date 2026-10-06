/**
 * Апдейты Bot API → нажатия и тексты (`docs/specs/platform/
 * telegram-questions.md`, «Приём апдейтов»; живые формы —
 * `fixtures/telegram-relay/bot-api/getUpdates-callbacks-and-text.json`).
 * Разбор — граница чужого формата: здесь и только здесь читаются поля
 * апдейта.
 */

/** Кому апдейт доставляется: чат вопросов. */
export interface Inbox {
  /** Нажатие кнопки `data` пользователем `from`. */
  press(from: number, callback: string, data: string): Promise<void>;
  /** Текстовое сообщение `text` пользователя `from`. */
  write(from: number, text: string): Promise<void>;
}

/** Свежесть апдейта по его дате (секунды Unix). */
export interface Freshness {
  admits(date: number): boolean;
}

/** Все апдейты свежие: опрос после первого. */
export const ANY_AGE: Freshness = { admits: () => true };

/**
 * Первый опрос после старта: датированное раньше старта накоплено до
 * запуска и ответом не считается.
 */
export class SinceStart implements Freshness {
  readonly #startedAt: number;

  /** @param startedAt момент старта, секунды Unix */
  constructor(startedAt: number) {
    this.#startedAt = startedAt;
  }

  admits(date: number): boolean {
    return date >= this.#startedAt;
  }
}

/** Апдейт опроса. */
export interface Update {
  /** `update_id`: следующий `offset` — на единицу больше. */
  readonly id: number;
  deliver(inbox: Inbox, fresh: Freshness): Promise<void>;
}

/**
 * Нажатие. Даты у `callback_query` нет (дата вложенного сообщения — дата
 * отправки, а не нажатия), поэтому свежесть его не касается: нажатие
 * кнопки прошлого запуска узнаётся по данным кнопки.
 */
class PressUpdate implements Update {
  constructor(
    readonly id: number,
    readonly from: number,
    readonly callback: string,
    readonly data: string,
  ) {}

  deliver(inbox: Inbox): Promise<void> {
    return inbox.press(this.from, this.callback, this.data);
  }
}

/** Текстовое сообщение. */
class TextUpdate implements Update {
  constructor(
    readonly id: number,
    readonly from: number,
    readonly date: number,
    readonly text: string,
  ) {}

  deliver(inbox: Inbox, fresh: Freshness): Promise<void> {
    if (!fresh.admits(this.date)) return Promise.resolve();
    return inbox.write(this.from, this.text);
  }
}

/** Апдейт иного вида (правка, стикер, фото): только сдвигает `offset`. */
class IgnoredUpdate implements Update {
  constructor(readonly id: number) {}

  deliver(): Promise<void> {
    return Promise.resolve();
  }
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null
    ? value as Fields
    : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Разбирает `result` ответа `getUpdates`. Апдейт без `update_id`
 * отбрасывается: сдвинуть по нему `offset` нельзя, а остальная пачка
 * сдвигается по своим.
 */
export function parseUpdates(result: unknown): readonly Update[] {
  if (!Array.isArray(result)) return [];
  const updates: Update[] = [];
  for (const item of result) {
    const fields = record(item);
    const id = numberOf(fields?.update_id);
    if (fields === undefined || id === undefined) continue;
    updates.push(
      pressOf(id, record(fields.callback_query)) ??
        messageOf(id, record(fields.message)) ??
        new IgnoredUpdate(id),
    );
  }
  return updates;
}

function pressOf(id: number, query: Fields | undefined): Update | undefined {
  const from = numberOf(record(query?.from)?.id);
  const callback = stringOf(query?.id);
  const data = stringOf(query?.data);
  if (from === undefined || callback === undefined || data === undefined) {
    return undefined;
  }
  return new PressUpdate(id, from, callback, data);
}

function messageOf(
  id: number,
  message: Fields | undefined,
): Update | undefined {
  const from = numberOf(record(message?.from)?.id);
  const date = numberOf(message?.date);
  const text = stringOf(message?.text);
  if (from === undefined || date === undefined || text === undefined) {
    return undefined;
  }
  return new TextUpdate(id, from, date, text);
}
