/**
 * Журнал переносов (`move-client.md`, «Побочные эффекты»): таблица
 * `client_moves` кэш-БД, по строке на клиента.
 *
 * Это единственный источник знания «откуда и куда переносили»:
 * `move-client-back` берёт направление только отсюда. Поэтому запись
 * появляется строго после успешной постановки задачи, а её отсутствие —
 * громкий отказ реверса, а не догадка по умолчанию.
 */

import type { CacheDb, SqlRow } from "../command/mod.ts";

/** Записанный ход клиента. */
export interface Move {
  readonly clientId: number;
  readonly source: string;
  readonly target: string;
  /** Момент записи, секунды эпохи. */
  readonly movedAt: number;
}

/**
 * Чтение журнала. Отсутствующая таблица равнозначна пустому журналу:
 * `mpu init` для чтения не требуется (`move-client-back.md`,
 * «Граничные случаи»), а до первого переноса таблицы может не быть.
 */
function read(
  db: CacheDb,
  sql: string,
  ...params: readonly (string | number)[]
): readonly SqlRow[] {
  try {
    return db.query(sql, ...params);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

/** Ход одного клиента; записи нет — `undefined`. */
export function moveOf(db: CacheDb, clientId: number): Move | undefined {
  const rows = read(
    db,
    "SELECT client_id, source, target, moved_at FROM client_moves" +
      " WHERE client_id = ?",
    clientId,
  );
  const row = rows[0];
  return row === undefined ? undefined : rowToMove(row);
}

/** Все ходы, новые сверху — в этом же порядке их печатает `ls`. */
export function moves(db: CacheDb): readonly Move[] {
  return read(
    db,
    "SELECT client_id, source, target, moved_at FROM client_moves" +
      " ORDER BY moved_at DESC, client_id",
  ).map(rowToMove);
}

/**
 * Записывает ход, заменяя прежний. На клиента хранится не более одной
 * записи — последней: журнал отвечает на вопрос «где клиент сейчас не
 * дома», а не ведёт историю (инвариант спеки).
 */
export function recordMove(
  db: CacheDb,
  move: Move,
): void {
  // Схема здесь не заводится намеренно. Спека требует: таблицы нет —
  // предупредить, что реверс станет невозможен (отклонение `fix`
  // `move-client.md`). Тихо создав схему, мы сделали бы это
  // предупреждение недостижимым, а вместе с ним — и повод сказать
  // оператору, что стенд не инициализирован.
  db.execute(
    "INSERT INTO client_moves (client_id, source, target, moved_at)" +
      " VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET" +
      " source = excluded.source, target = excluded.target," +
      " moved_at = excluded.moved_at",
    move.clientId,
    move.source,
    move.target,
    move.movedAt,
  );
}

/** Удаляет запись; возвращает `true`, если она была. */
export function forgetMove(db: CacheDb, clientId: number): boolean {
  try {
    return db.execute(
      "DELETE FROM client_moves WHERE client_id = ?",
      clientId,
    ) >
      0;
  } catch (err) {
    // Нет таблицы — нечего и удалять: во всех формах отсутствие
    // таблицы читается как «записей нет» (`move-client-back.md`).
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

function rowToMove(row: SqlRow): Move {
  return {
    clientId: Number(row.client_id),
    source: String(row.source),
    target: String(row.target),
    movedAt: Number(row.moved_at),
  };
}
