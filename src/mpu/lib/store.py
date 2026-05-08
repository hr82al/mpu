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
    """
    CREATE TABLE IF NOT EXISTS portainer_containers (
        portainer_url   TEXT NOT NULL,
        endpoint_id     INTEGER NOT NULL,
        endpoint_name   TEXT,
        container_id    TEXT NOT NULL,
        container_name  TEXT NOT NULL,
        server_number   INTEGER,
        state           TEXT,
        image           TEXT,
        discovered_at   INTEGER NOT NULL,
        PRIMARY KEY (portainer_url, endpoint_id, container_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_portainer_endpoint ON portainer_containers(endpoint_id)",
    (
        "CREATE INDEX IF NOT EXISTS idx_portainer_server_number "
        "ON portainer_containers(server_number)"
    ),
    (
        "CREATE INDEX IF NOT EXISTS idx_portainer_container_name "
        "ON portainer_containers(container_name)"
    ),
]


def bootstrap(conn: sqlite3.Connection) -> None:
    """Создать таблицы и индексы (идемпотентно, `CREATE IF NOT EXISTS`).

    Вызывается явно из `mpu init` — `open_store()` сам схему НЕ создаёт. Тесты,
    которым нужны таблицы, вызывают `bootstrap()` после `open_store()`.
    """
    cur = conn.cursor()
    for stmt in _DDL:
        cur.execute(stmt)
    conn.commit()


def open_store(path: Path | str | None = None) -> sqlite3.Connection:
    """Открыть/создать `mpu.db`. Возвращает Connection. **Схему не создаёт.**

    Bootstrap делается явно через `mpu init` (вызывает `bootstrap()`). Команды,
    зависящие от таблиц, ожидают что `mpu init` уже отработал; иначе — чистый
    `sqlite3.OperationalError: no such table`.

    `path=None` ⇒ использовать текущее значение `store.DB_PATH` (даёт тестам
    возможность подменить путь через monkeypatch).
    """
    target = Path(DB_PATH if path is None else path)
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def store(path: Path | str | None = None) -> Generator[sqlite3.Connection]:
    conn = open_store(path)
    try:
        yield conn
    finally:
        conn.close()
