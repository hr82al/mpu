"""Журнал привязок карточек Kaiten к значениям кастомных полей в `~/.config/mpu/mpu.db`.

`mpu kiten field set/ls/update/rm` кладёт значение (MR-ссылка / гипотеза / что сделано /
результат) в кастомное поле карточки И ведёт историю в SQLite — на одну карточку может быть
несколько записей (например несколько MR). Само поле карточки отражает **последнюю по времени**
запись для пары (card, field); полная история живёт в логе.

Здесь — чистые SQLite-функции (без сети), покрытые тестами; сетевую часть (PATCH /cards) делает
команда `mpu kiten field` через `KaitenClient.set_card_property`.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

# Кастомные поля карточки (btlz.kaiten.ru, GET /company/custom-properties → id).
FIELD_PROPERTY_IDS: dict[str, int] = {
    "mr": 398965,  # "Ссылка на Merge Request" (тип url)
    "hypothesis": 291984,  # "6. Причина/гипотеза"
    "done": 291985,  # "7. Что сделано"
    "result": 291990,  # "8. Результат"
}

FIELD_KINDS: tuple[str, ...] = tuple(FIELD_PROPERTY_IDS)


@dataclass(frozen=True, slots=True)
class CardLink:
    id: int
    card_id: int
    field: str
    value: str
    created_at: int


@dataclass(frozen=True, slots=True)
class CardMove:
    id: int
    card_id: int
    title: str | None
    url: str | None
    to_column: str
    from_column: str | None
    lane: str | None
    board: str | None
    note: str | None
    moved_at: int


def property_key(field: str) -> str:
    """Ключ кастомного поля карточки (`id_NNN`) для тела PATCH /cards."""
    return f"id_{FIELD_PROPERTY_IDS[field]}"


def _row_to_link(row: sqlite3.Row) -> CardLink:
    return CardLink(
        id=int(row["id"]),
        card_id=int(row["card_id"]),
        field=str(row["field"]),
        value=str(row["value"]),
        created_at=int(row["created_at"]),
    )


def record_link(
    conn: sqlite3.Connection,
    card_id: int,
    field: str,
    value: str,
    *,
    now: int | None = None,
) -> CardLink:
    """Добавить запись в лог (одна из многих для card/field). Возвращает созданную строку."""
    ts = int(time.time()) if now is None else now
    cur = conn.execute(
        "INSERT INTO kaiten_card_links (card_id, field, value, created_at) VALUES (?, ?, ?, ?)",
        (card_id, field, value, ts),
    )
    conn.commit()
    rowid = cur.lastrowid
    if rowid is None:
        raise RuntimeError("kaiten_card_links insert returned no rowid")
    return CardLink(id=int(rowid), card_id=card_id, field=field, value=value, created_at=ts)


def get_link(conn: sqlite3.Connection, record_id: int) -> CardLink | None:
    row = conn.execute(
        "SELECT id, card_id, field, value, created_at FROM kaiten_card_links WHERE id = ?",
        (record_id,),
    ).fetchone()
    return _row_to_link(row) if row is not None else None


def list_links(
    conn: sqlite3.Connection,
    *,
    card_id: int | None = None,
    field: str | None = None,
) -> list[CardLink]:
    """Лог привязок, новые сверху. Опционально фильтр по card_id и/или field."""
    where: list[str] = []
    params: list[str | int] = []
    if card_id is not None:
        where.append("card_id = ?")
        params.append(card_id)
    if field is not None:
        where.append("field = ?")
        params.append(field)
    sql = "SELECT id, card_id, field, value, created_at FROM kaiten_card_links"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC, id DESC"
    return [_row_to_link(r) for r in conn.execute(sql, params).fetchall()]


def update_link(conn: sqlite3.Connection, record_id: int, value: str) -> CardLink | None:
    """Обновить значение записи. Возвращает обновлённую строку или None, если записи нет."""
    if get_link(conn, record_id) is None:
        return None
    conn.execute("UPDATE kaiten_card_links SET value = ? WHERE id = ?", (value, record_id))
    conn.commit()
    return get_link(conn, record_id)


def delete_link(conn: sqlite3.Connection, record_id: int) -> CardLink | None:
    """Удалить запись. Возвращает удалённую строку (для ре-синка поля) или None."""
    link = get_link(conn, record_id)
    if link is None:
        return None
    conn.execute("DELETE FROM kaiten_card_links WHERE id = ?", (record_id,))
    conn.commit()
    return link


def latest_value(conn: sqlite3.Connection, card_id: int, field: str) -> str | None:
    """Значение последней по времени записи для (card, field); None — если записей нет."""
    links = list_links(conn, card_id=card_id, field=field)
    return links[0].value if links else None


# ── Перемещения карточек (kaiten_card_moves) — журнал для `mpu telegram status` ──


def _opt_str(value: object) -> str | None:
    return None if value is None else str(value)


def _row_to_move(row: sqlite3.Row) -> CardMove:
    return CardMove(
        id=int(row["id"]),
        card_id=int(row["card_id"]),
        title=_opt_str(row["title"]),
        url=_opt_str(row["url"]),
        to_column=str(row["to_column"]),
        from_column=_opt_str(row["from_column"]),
        lane=_opt_str(row["lane"]),
        board=_opt_str(row["board"]),
        note=_opt_str(row["note"]),
        moved_at=int(row["moved_at"]),
    )


def record_move(
    conn: sqlite3.Connection,
    card_id: int,
    to_column: str,
    *,
    title: str | None = None,
    url: str | None = None,
    from_column: str | None = None,
    lane: str | None = None,
    board: str | None = None,
    note: str | None = None,
    now: int | None = None,
) -> CardMove:
    """Записать перемещение карточки в `kaiten_card_moves`. Возвращает созданную строку."""
    ts = int(time.time()) if now is None else now
    cur = conn.execute(
        "INSERT INTO kaiten_card_moves"
        " (card_id, title, url, to_column, from_column, lane, board, note, moved_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (card_id, title, url, to_column, from_column, lane, board, note, ts),
    )
    conn.commit()
    rowid = cur.lastrowid
    if rowid is None:
        raise RuntimeError("kaiten_card_moves insert returned no rowid")
    return CardMove(
        id=int(rowid),
        card_id=card_id,
        title=title,
        url=url,
        to_column=to_column,
        from_column=from_column,
        lane=lane,
        board=board,
        note=note,
        moved_at=ts,
    )


def list_moves(
    conn: sqlite3.Connection,
    *,
    card_id: int | None = None,
    since: int | None = None,
    until: int | None = None,
) -> list[CardMove]:
    """Журнал перемещений, новые сверху. Фильтры: card_id и инклюзивное окно [since, until]
    по `moved_at` (epoch-секунды)."""
    where: list[str] = []
    params: list[int] = []
    if card_id is not None:
        where.append("card_id = ?")
        params.append(card_id)
    if since is not None:
        where.append("moved_at >= ?")
        params.append(since)
    if until is not None:
        where.append("moved_at <= ?")
        params.append(until)
    sql = (
        "SELECT id, card_id, title, url, to_column, from_column, lane, board, note, moved_at"
        " FROM kaiten_card_moves"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY moved_at DESC, id DESC"
    return [_row_to_move(r) for r in conn.execute(sql, params).fetchall()]
