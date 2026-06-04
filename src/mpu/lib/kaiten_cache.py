"""Кэш справочника Kaiten (spaces/boards/lanes) в `~/.config/mpu/mpu.db` для `mpu kiten`.

Зеркало `loki_discover` + ридеров `_logs_loki`: `mpu init` (и `mpu kiten spaces/boards/lanes`)
best-effort тянут `GET /spaces` (+ `GET /boards/{id}/lanes`) и кладут в SQLite; completion
и резолв `--space/--board/--lane` читают кэш через тонкие ридеры (`cached_spaces` и т.п.).

Дорожки (lanes) дороже: глобального списка у Kaiten нет — это +1 запрос на доску
(`discover_lanes_and_store`), поэтому отделены от быстрого `discover_and_store` (1 запрос).

Чистые хелперы (`filter_refs`, `resolve_ref`) работают над plain-списком rows и покрыты
тестами без БД и без сети.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from urllib.error import URLError

from mpu.lib import env, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenBoard,
    KaitenClient,
    KaitenColumn,
    KaitenLane,
    KaitenSpace,
)


@dataclass(frozen=True, slots=True)
class KaitenDiscoveryResult:
    spaces: list[KaitenSpace]
    boards: list[KaitenBoard]
    error: str | None = None


@dataclass(frozen=True, slots=True)
class KaitenLanesResult:
    lanes: list[KaitenLane]
    error: str | None = None


@dataclass(frozen=True, slots=True)
class KaitenColumnsResult:
    columns: list[KaitenColumn]
    error: str | None = None


def discover_and_store() -> KaitenDiscoveryResult:
    """`GET /spaces` → запись в SQLite (DELETE+INSERT). Best-effort.

    Если `KITEN_API_KEY` не задан или Kaiten недоступен — возвращает результат с `error`,
    не бросает (как Loki при отсутствии `LOKI_URL`). Вызывается из `mpu init` и из
    листинг-подкоманд `mpu kiten spaces/boards`.
    """
    if not env.get("KITEN_API_KEY"):
        return KaitenDiscoveryResult(spaces=[], boards=[], error="KITEN_API_KEY не задан")

    try:
        client = KaitenClient.from_env()
        spaces, boards = client.list_spaces()
    except (KaitenAPIError, URLError, OSError) as e:
        return KaitenDiscoveryResult(spaces=[], boards=[], error=f"kaiten: {e}")

    discovered_at = int(time.time())
    with store.store() as conn, conn:
        store.bootstrap(conn)  # идемпотентно: kaiten_* таблицы могут отсутствовать без mpu init
        conn.execute("DELETE FROM kaiten_spaces")
        conn.executemany(
            "INSERT INTO kaiten_spaces (id, title, archived, discovered_at) VALUES (?, ?, ?, ?)",
            [(s.id, s.title, int(s.archived), discovered_at) for s in spaces],
        )
        conn.execute("DELETE FROM kaiten_boards")
        conn.executemany(
            "INSERT INTO kaiten_boards (id, space_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(b.id, b.space_id, b.title, discovered_at) for b in boards],
        )

    return KaitenDiscoveryResult(spaces=spaces, boards=boards, error=None)


def discover_lanes_and_store(board_ids: list[int]) -> KaitenLanesResult:
    """`GET /boards/{id}/lanes` по каждой доске → запись в SQLite. Best-effort.

    DELETE+INSERT **только** по переданным `board_ids` (scoped), чтобы частичный
    рефреш (`mpu kiten lanes --board X`) не стирал кэш остальных досок. Полный
    рефреш — `mpu init` со всеми board_ids. +1 запрос на доску (см. модуль-док).
    """
    if not env.get("KITEN_API_KEY"):
        return KaitenLanesResult(lanes=[], error="KITEN_API_KEY не задан")
    if not board_ids:
        return KaitenLanesResult(lanes=[], error=None)

    try:
        client = KaitenClient.from_env()
        lanes = client.list_lanes(board_ids)
    except (KaitenAPIError, URLError, OSError) as e:
        return KaitenLanesResult(lanes=[], error=f"kaiten: {e}")

    discovered_at = int(time.time())
    placeholders = ",".join("?" * len(board_ids))
    with store.store() as conn, conn:
        store.bootstrap(conn)  # идемпотентно: kaiten_lanes может отсутствовать без mpu init
        conn.execute(
            f"DELETE FROM kaiten_lanes WHERE board_id IN ({placeholders})",
            board_ids,
        )
        conn.executemany(
            "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(lane.id, lane.board_id, lane.title, discovered_at) for lane in lanes],
        )

    return KaitenLanesResult(lanes=lanes, error=None)


def discover_columns_and_store(board_ids: list[int]) -> KaitenColumnsResult:
    """`GET /boards/{id}/columns` по каждой доске → запись в SQLite. Best-effort.

    Скоупленный DELETE+INSERT по `board_ids` (как `discover_lanes_and_store`). +1
    запрос на доску. Карточный фильтр `column_id` ссылается на `column.id`.
    """
    if not env.get("KITEN_API_KEY"):
        return KaitenColumnsResult(columns=[], error="KITEN_API_KEY не задан")
    if not board_ids:
        return KaitenColumnsResult(columns=[], error=None)

    try:
        client = KaitenClient.from_env()
        columns = client.list_columns(board_ids)
    except (KaitenAPIError, URLError, OSError) as e:
        return KaitenColumnsResult(columns=[], error=f"kaiten: {e}")

    discovered_at = int(time.time())
    placeholders = ",".join("?" * len(board_ids))
    with store.store() as conn, conn:
        store.bootstrap(conn)  # идемпотентно: kaiten_columns может отсутствовать без mpu init
        conn.execute(
            f"DELETE FROM kaiten_columns WHERE board_id IN ({placeholders})",
            board_ids,
        )
        conn.executemany(
            "INSERT INTO kaiten_columns (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(col.id, col.board_id, col.title, discovered_at) for col in columns],
        )

    return KaitenColumnsResult(columns=columns, error=None)


# ── Тонкие ридеры кэша (I/O; try/except → [], как _logs_loki.cached_hosts) ──────


def cached_spaces() -> list[tuple[int, str]]:
    """(id, title) спейсов из кэша; активные первыми. Пусто, если кэш не заполнен."""
    try:
        with store.store() as conn:
            rows = conn.execute(
                "SELECT id, title FROM kaiten_spaces ORDER BY archived, title"
            ).fetchall()
    except sqlite3.Error:
        return []
    return [(int(r["id"]), r["title"]) for r in rows]


def cached_boards(space_id: int | None = None) -> list[tuple[int, str]]:
    """(id, title) досок из кэша; опц. фильтр по space_id."""
    try:
        with store.store() as conn:
            if space_id is None:
                rows = conn.execute("SELECT id, title FROM kaiten_boards ORDER BY title").fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, title FROM kaiten_boards WHERE space_id = ? ORDER BY title",
                    (space_id,),
                ).fetchall()
    except sqlite3.Error:
        return []
    return [(int(r["id"]), r["title"]) for r in rows]


def cached_lanes(board_id: int | None = None) -> list[tuple[int, str]]:
    """(id, title) дорожек из кэша; опц. фильтр по board_id (для скоупа --board)."""
    try:
        with store.store() as conn:
            if board_id is None:
                rows = conn.execute("SELECT id, title FROM kaiten_lanes ORDER BY title").fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, title FROM kaiten_lanes WHERE board_id = ? ORDER BY title",
                    (board_id,),
                ).fetchall()
    except sqlite3.Error:
        return []
    return [(int(r["id"]), r["title"]) for r in rows]


def cached_columns(board_id: int | None = None) -> list[tuple[int, str]]:
    """(id, title) колонок из кэша; опц. фильтр по board_id (для скоупа --board)."""
    try:
        with store.store() as conn:
            if board_id is None:
                rows = conn.execute(
                    "SELECT id, title FROM kaiten_columns ORDER BY title"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, title FROM kaiten_columns WHERE board_id = ? ORDER BY title",
                    (board_id,),
                ).fetchall()
    except sqlite3.Error:
        return []
    return [(int(r["id"]), r["title"]) for r in rows]


# ── Чистые хелперы (без БД/сети, тестируемые) ──────────────────────────────────


def filter_refs(incomplete: str, rows: list[tuple[int, str]]) -> list[tuple[str, str]]:
    """Для shell completion: матч `incomplete` по префиксу ID или подстроке title.

    Возвращает `(value, help)` = `(str(id), title)`: shell вставит ID (парсится в int),
    title показывается как подсказка. Пустой `incomplete` → все строки.
    """
    needle = incomplete.strip().casefold()
    out: list[tuple[str, str]] = []
    for ref_id, title in rows:
        if not needle or str(ref_id).startswith(needle) or needle in title.casefold():
            out.append((str(ref_id), title))
    return out


def resolve_ref(ref: str, rows: list[tuple[int, str]], *, kind: str) -> int:
    """ID-или-подстрока-названия → числовой ID по кэшу `rows`.

    Чисто-цифровой `ref` трактуется как ID (работает и при пустом кэше). Иначе —
    casefold-substring по title: 0 совпадений → ValueError, >1 → ValueError со списком
    кандидатов (обработка коллизий). `kind` ∈ {"space", "board"} — для текста ошибок.
    """
    ref = ref.strip()
    if ref.isdigit():
        return int(ref)
    matches = [(rid, title) for rid, title in rows if ref.casefold() in title.casefold()]
    if len(matches) == 1:
        return matches[0][0]
    if not matches:
        raise ValueError(f"{kind} '{ref}' не найден — см. `mpu kiten {kind}s`")
    candidates = ", ".join(f"{rid} ({title})" for rid, title in matches[:10])
    raise ValueError(f"{kind} '{ref}' неоднозначен ({len(matches)} совпадений): {candidates}")
