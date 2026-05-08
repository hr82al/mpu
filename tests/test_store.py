"""Тесты `lib/store.py` — `bootstrap` и идемпотентность схемы.

Контракт после рефакторинга: `open_store()` НЕ создаёт схему — это делает явный
`bootstrap(conn)`. Команды, использующие SQLite, ожидают что `mpu init` уже
выполнен, иначе получат `sqlite3.OperationalError: no such table`.
"""

import sqlite3
from pathlib import Path

import pytest

from mpu.lib import store


def test_open_store_does_not_create_schema(tmp_path: Path) -> None:
    """open_store больше не делает DDL — таблиц нет."""
    db = tmp_path / "sub" / "mpu.db"
    conn = store.open_store(db)
    try:
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert tables == set()
    finally:
        conn.close()


def test_bootstrap_creates_all_schema(tmp_path: Path) -> None:
    db = tmp_path / "sub" / "mpu.db"
    assert not db.exists()

    with store.store(db) as conn:
        store.bootstrap(conn)
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert "sl_clients" in tables
        assert "sl_spreadsheets" in tables
        assert "portainer_containers" in tables

        idx = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
        }
        assert "idx_sl_clients_server" in idx
        assert "idx_sl_ss_client" in idx
        assert "idx_sl_ss_title" in idx
        assert "idx_portainer_endpoint" in idx
        assert "idx_portainer_server_number" in idx


def test_bootstrap_idempotent(tmp_path: Path) -> None:
    """Повторный bootstrap не теряет данные и не падает."""
    db = tmp_path / "mpu.db"
    with store.store(db) as conn:
        store.bootstrap(conn)
        conn.execute(
            "INSERT INTO sl_clients "
            "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
            "VALUES (1, 'sl-1', 1, 0, 0, 100)"
        )
        conn.commit()

    with store.store(db) as conn:
        store.bootstrap(conn)  # повторный bootstrap — должен быть no-op для данных
        rows = conn.execute("SELECT client_id FROM sl_clients").fetchall()
        assert len(rows) == 1


def test_writes_without_bootstrap_fail_loud(tmp_path: Path) -> None:
    db = tmp_path / "mpu.db"
    with (
        store.store(db) as conn,
        pytest.raises(sqlite3.OperationalError, match="no such table"),
    ):
        conn.execute("INSERT INTO sl_clients (client_id, server) VALUES (1, 'x')")


def test_store_context_manager_with_bootstrap(tmp_path: Path) -> None:
    db = tmp_path / "mpu.db"
    with store.store(db) as conn:
        store.bootstrap(conn)
        conn.execute(
            "INSERT INTO sl_spreadsheets "
            "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
            "VALUES ('ss1', 42, 'Title', 'tmpl', 1, 'sl-2', 200)"
        )
        conn.commit()

    with store.store(db) as conn:
        row = conn.execute(
            "SELECT client_id, title, server FROM sl_spreadsheets WHERE ss_id='ss1'"
        ).fetchone()
        assert row["client_id"] == 42
        assert row["title"] == "Title"
        assert row["server"] == "sl-2"
