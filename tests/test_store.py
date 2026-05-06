"""Тесты `lib/store.py` — bootstrap и идемпотентность схемы."""

from pathlib import Path

from mpu.lib import store


def test_open_store_creates_db_and_schema(tmp_path: Path) -> None:
    db = tmp_path / "sub" / "mpu.db"
    assert not db.exists()

    conn = store.open_store(db)
    try:
        assert db.exists()
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert "sl_clients" in tables
        assert "sl_spreadsheets" in tables

        idx = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
        }
        assert "idx_sl_clients_server" in idx
        assert "idx_sl_ss_client" in idx
        assert "idx_sl_ss_title" in idx
    finally:
        conn.close()


def test_open_store_idempotent(tmp_path: Path) -> None:
    db = tmp_path / "mpu.db"
    conn = store.open_store(db)
    conn.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (1, 'sl-1', 1, 0, 0, 100)"
    )
    conn.commit()
    conn.close()

    conn2 = store.open_store(db)
    try:
        rows = conn2.execute("SELECT client_id FROM sl_clients").fetchall()
        assert len(rows) == 1
    finally:
        conn2.close()


def test_store_context_manager(tmp_path: Path) -> None:
    db = tmp_path / "mpu.db"
    with store.store(db) as conn:
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
