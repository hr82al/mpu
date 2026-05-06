"""Локальный SQLite-кэш `~/.config/mpu/mpu.db`.

Переиспользует существующие таблицы `sl_clients` и `sl_spreadsheets` (созданные
прежними утилитами); на свежей машине создаёт их сам через `CREATE IF NOT EXISTS`.
"""

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path.home() / ".config" / "mpu" / "mpu.db"

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS sl_clients (
        client_id   INTEGER PRIMARY KEY,
        server      TEXT,
        is_active   INTEGER NOT NULL,
        is_locked   INTEGER NOT NULL,
        is_deleted  INTEGER NOT NULL,
        synced_at   INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sl_clients_server ON sl_clients(server)",
    """
    CREATE TABLE IF NOT EXISTS sl_spreadsheets (
        ss_id          TEXT PRIMARY KEY,
        client_id      INTEGER NOT NULL,
        title          TEXT NOT NULL,
        template_name  TEXT,
        is_active      INTEGER NOT NULL,
        server         TEXT,
        synced_at      INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sl_ss_client ON sl_spreadsheets(client_id)",
    "CREATE INDEX IF NOT EXISTS idx_sl_ss_title ON sl_spreadsheets(title)",
]


def _ensure_schema(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    for stmt in _DDL:
        cur.execute(stmt)
    conn.commit()


def open_store(path: Path | str | None = None) -> sqlite3.Connection:
    """Открыть/создать `mpu.db`, гарантировать схему. Возвращает Connection.

    `path=None` ⇒ использовать текущее значение `store.DB_PATH` (даёт тестам
    возможность подменить путь через monkeypatch).
    """
    target = Path(DB_PATH if path is None else path)
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    _ensure_schema(conn)
    return conn


@contextmanager
def store(path: Path | str | None = None) -> Generator[sqlite3.Connection]:
    conn = open_store(path)
    try:
        yield conn
    finally:
        conn.close()
