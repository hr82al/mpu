"""Журнал переносов клиентов (`mpu move-client`) в SQLite-таблице `client_moves`.

Одна строка на клиента (PK `client_id`) = последний ход «откуда → куда». `move-client`
делает upsert после успешной постановки job'а; `move-client-back` читает строку для
реверса и удаляет её после успешного обратного переноса.

Функции открывают store сами (как `resolver.resolve_server`) и толерантны к отсутствию
таблицы: если `mpu init` ещё не выполнялся, запись/удаление тихо пропускаются с warn,
`last_move`/`list_moves` возвращают пустой результат.
"""

import sqlite3
import time
from typing import TypedDict

from mpu.lib import store
from mpu.lib.log import logger


class Move(TypedDict):
    """Строка `client_moves` — последний перенос клиента."""

    client_id: int
    source: str
    target: str
    moved_at: int


def _row_to_move(row: sqlite3.Row) -> Move:
    return Move(
        client_id=int(row["client_id"]),
        source=str(row["source"]),
        target=str(row["target"]),
        moved_at=int(row["moved_at"]),
    )


def record_move(client_id: int, source: str, target: str, *, now: int | None = None) -> None:
    """Записать (upsert) последний ход клиента: `source` → `target`."""
    ts = now if now is not None else int(time.time())
    try:
        with store.store() as conn:
            conn.execute(
                "INSERT INTO client_moves (client_id, source, target, moved_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(client_id) DO UPDATE SET "
                "source=excluded.source, target=excluded.target, moved_at=excluded.moved_at",
                (client_id, source, target, ts),
            )
            conn.commit()
    except sqlite3.OperationalError as e:
        logger.warning(f"client_moves: запись хода пропущена (запусти `mpu init`?): {e}")


def last_move(client_id: int) -> Move | None:
    """Последний записанный ход клиента или `None`, если записи нет."""
    try:
        with store.store() as conn:
            row = conn.execute(
                "SELECT client_id, source, target, moved_at FROM client_moves WHERE client_id = ?",
                (client_id,),
            ).fetchone()
    except sqlite3.OperationalError:
        return None
    return _row_to_move(row) if row is not None else None


def list_moves() -> list[Move]:
    """Все незавершённые ходы (newest first); пустой список если таблицы/строк нет."""
    try:
        with store.store() as conn:
            rows = conn.execute(
                "SELECT client_id, source, target, moved_at FROM client_moves "
                "ORDER BY moved_at DESC"
            ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [_row_to_move(r) for r in rows]


def clear_move(client_id: int) -> None:
    """Удалить запись хода клиента (после успешного реверса)."""
    try:
        with store.store() as conn:
            conn.execute("DELETE FROM client_moves WHERE client_id = ?", (client_id,))
            conn.commit()
    except sqlite3.OperationalError:
        return
