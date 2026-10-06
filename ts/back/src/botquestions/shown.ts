/**
 * Память показанных сообщений с кнопками до перезапуска ядра
 * (`docs/specs/platform/telegram-questions.md`, «Перезапуск»). Таблица —
 * у этого модуля, как у `task`: эталон схемы кэш-БД
 * (`platform/store.md`) её не содержит и не правится.
 */

import type { CacheDb } from "../command/mod.ts";
import { type Body, Card } from "./card.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS telegram_questions (
    message_id INTEGER PRIMARY KEY,
    card       TEXT NOT NULL
  )`;

/** Показанное сообщение: номер и тело. */
export interface ShownMessage {
  readonly id: number;
  readonly body: Body;
}

/** Показанные сообщения с действующими кнопками. */
export interface ShownMessages {
  /** Запоминает (или обновляет) тело сообщения `id`. */
  remember(id: number, card: Card): void;
  forget(id: number): void;
  /** Все запомненные. */
  all(): readonly ShownMessage[];
}

/** Памяти нет (нет каталога состояния): перезапуск правит нечего. */
export const NO_MEMORY: ShownMessages = {
  remember: () => {},
  forget: () => {},
  all: () => [],
};

/**
 * Память в кэш-БД. Сбой базы вопроса не роняет: показанное сообщение
 * без записи лишь не поправится в «истёк» при перезапуске — строка в
 * журнал службы.
 */
export class StoredMessages implements ShownMessages {
  readonly #open: () => CacheDb;
  readonly #diagnose: (line: string) => void;

  constructor(open: () => CacheDb, diagnose: (line: string) => void) {
    this.#open = open;
    this.#diagnose = diagnose;
  }

  remember(id: number, card: Card): void {
    this.#with((db) => {
      db.execute(
        "INSERT INTO telegram_questions (message_id, card) VALUES (?, ?)" +
          " ON CONFLICT (message_id) DO UPDATE SET card = excluded.card",
        id,
        JSON.stringify(card),
      );
    });
  }

  forget(id: number): void {
    this.#with((db) => {
      db.execute("DELETE FROM telegram_questions WHERE message_id = ?", id);
    });
  }

  all(): readonly ShownMessage[] {
    let shown: readonly ShownMessage[] = [];
    this.#with((db) => {
      shown = db.query(
        "SELECT message_id, card FROM telegram_questions ORDER BY message_id",
      ).map((row) => ({
        id: Number(row.message_id),
        body: Card.parse(String(row.card)),
      }));
    });
    return shown;
  }

  #with(work: (db: CacheDb) => void): void {
    try {
      using db = this.#open();
      db.execute(SCHEMA);
      work(db);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      this.#diagnose(`telegram: память вопросов: ${err.message}`);
    }
  }
}
