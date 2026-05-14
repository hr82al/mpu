"""Тесты `commands/search.py` — поиск, проекция, fallback на update."""

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import search
from mpu.lib import servers, store

runner = CliRunner()


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)

    env = tmp_path / ".env"
    env.write_text("sl_1='10.0.0.1'\nsl_2='10.0.0.2'\npg_1='10.1.0.1'\npg_2='10.1.0.2'\n")
    monkeypatch.setattr(servers, "ENV_PATH", env)
    servers.reset_cache()

    conn = store.open_store(db_path)
    store.bootstrap(conn)
    conn.executemany(
        "INSERT INTO sl_clients "
        "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (10, "sl-1", 1, 0, 0, 100),
            (20, "sl-2", 1, 0, 0, 100),
            (30, "sl-1", 1, 0, 0, 100),
            (40, "sl-2", 1, 0, 0, 100),
        ],
    )
    conn.executemany(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("1NHoyZVE_alpha", 10, "ИП Иванов", "tmpl", 1, "sl-1", 100),
            ("1NHoyZVE_beta", 10, "ИП Иванов второй", "tmpl", 1, "sl-1", 100),
            ("ssBETA12345xx", 20, "ООО Петров", "tmpl", 1, "sl-2", 100),
            ("ssGAMMA999", 30, "ИП Сидоров", "tmpl", 1, "sl-1", 100),
        ],
    )
    conn.commit()
    yield conn
    conn.close()
    servers.reset_cache()


def test_search_by_client_id_returns_only_that_client(db: sqlite3.Connection) -> None:
    results = search.search(db, "10")
    assert {r["client_id"] for r in results} == {10}
    assert {r["spreadsheet_id"] for r in results} == {
        "1NHoyZVE_alpha",
        "1NHoyZVE_beta",
    }


def test_search_int_does_not_fall_back_to_title(db: sqlite3.Connection) -> None:
    results = search.search(db, "999")
    # client_id 999 нет; спускаться на title-substring (где "999" есть в ssGAMMA999) НЕ должно
    assert results == []


def test_search_client_id_without_spreadsheets(db: sqlite3.Connection) -> None:
    results = search.search(db, "40")
    assert len(results) == 1
    assert results[0]["client_id"] == 40
    assert results[0]["spreadsheet_id"] is None
    assert results[0]["server"] == "sl-2"
    assert results[0]["server_number"] == 2
    assert results[0]["sl_ip"] == "10.0.0.2"
    assert results[0]["pg_ip"] == "10.1.0.2"


def test_search_by_spreadsheet_substring(db: sqlite3.Connection) -> None:
    results = search.search(db, "BETA")
    ss_ids = {r["spreadsheet_id"] for r in results}
    assert "1NHoyZVE_beta" in ss_ids
    assert "ssBETA12345xx" in ss_ids


def test_search_falls_through_spreadsheet_to_title(db: sqlite3.Connection) -> None:
    # "Иванов" нет в ss_id, но есть в title — должен сработать title-уровень
    results = search.search(db, "Иванов")
    titles = {r["title"] for r in results}
    assert titles == {"ИП Иванов", "ИП Иванов второй"}


def test_search_spreadsheet_match_blocks_title(db: sqlite3.Connection) -> None:
    # "GAMMA" есть в ss_id (ssGAMMA999), title-уровень не должен вызываться
    results = search.search(db, "GAMMA")
    assert len(results) == 1
    assert results[0]["spreadsheet_id"] == "ssGAMMA999"


def test_search_empty(db: sqlite3.Connection) -> None:
    assert search.search(db, "DEFINITELY_NOT_THERE_xyz") == []


def test_search_by_pg_ip(db: sqlite3.Connection) -> None:
    """IP из `.env` → синтетический row с `server_number`, без клиентов/spreadsheets."""
    results = search.search(db, "10.1.0.2")
    assert len(results) == 1
    r = results[0]
    assert r["client_id"] is None
    assert r["spreadsheet_id"] is None
    assert r["title"] is None
    assert r["server"] == "sl-2"
    assert r["server_number"] == 2
    assert r["sl_ip"] == "10.0.0.2"
    assert r["pg_ip"] == "10.1.0.2"


def test_search_by_sl_ip(db: sqlite3.Connection) -> None:
    results = search.search(db, "10.0.0.1")
    assert len(results) == 1
    assert results[0]["server_number"] == 1


def test_search_unknown_ip_empty(db: sqlite3.Connection) -> None:
    """Похоже на IP, но не в `.env` — пустой результат, без fallback на title-substring."""
    assert search.search(db, "9.9.9.9") == []


def test_cli_default_outputs_json(db: sqlite3.Connection) -> None:
    res = runner.invoke(search.app, ["10", "--no-update"])
    assert res.exit_code == 0
    parsed: list[dict[str, object]] = json.loads(res.stdout)
    assert isinstance(parsed, list)
    assert {r["client_id"] for r in parsed} == {10}
    assert parsed[0]["sl_ip"] == "10.0.0.1"


def test_cli_projection_client_id(db: sqlite3.Connection) -> None:
    res = runner.invoke(search.app, ["10", "--client-id", "--no-update"])
    assert res.exit_code == 0
    lines = [ln for ln in res.stdout.splitlines() if ln]
    assert lines == ["10", "10"]  # 2 spreadsheets под client 10


def test_cli_projection_pg_ip(db: sqlite3.Connection) -> None:
    res = runner.invoke(search.app, ["20", "--pg-ip", "--no-update"])
    assert res.exit_code == 0
    lines = [ln for ln in res.stdout.splitlines() if ln]
    assert lines == ["10.1.0.2"]


def test_cli_two_projection_flags_error(db: sqlite3.Connection) -> None:
    res = runner.invoke(search.app, ["10", "--client-id", "--pg-ip", "--no-update"])
    assert res.exit_code == 2


def test_cli_empty_with_no_update(db: sqlite3.Connection) -> None:
    res = runner.invoke(search.app, ["NOPE_XYZ", "--no-update"])
    assert res.exit_code == 0
    assert json.loads(res.stdout) == []


def test_cli_empty_triggers_auto_update(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Empty result → run_update должен быть вызван ровно один раз."""
    calls: list[bool] = []

    def fake_update(quiet: bool = False) -> tuple[int, int, float]:
        calls.append(quiet)
        # после "update" — ничего не добавляем; повторный поиск тоже пустой.
        return (0, 0, 0.0)

    from mpu.commands import update as update_mod

    monkeypatch.setattr(update_mod, "run_update", fake_update)

    res = runner.invoke(search.app, ["NOPE_XYZ"])
    assert res.exit_code == 0
    assert calls == [True]
    assert json.loads(res.stdout) == []


def test_cli_unknown_ip_skips_auto_update(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Похоже на IP, но не в `.env` — auto-update не вызывается (он не трогает `.env`)."""
    calls: list[bool] = []

    def fake_update(quiet: bool = False) -> tuple[int, int, float]:
        calls.append(quiet)
        return (0, 0, 0.0)

    from mpu.commands import update as update_mod

    monkeypatch.setattr(update_mod, "run_update", fake_update)

    res = runner.invoke(search.app, ["9.9.9.9"])
    assert res.exit_code == 0
    assert calls == []
    assert json.loads(res.stdout) == []


def test_cli_pg_ip_projection(db: sqlite3.Connection) -> None:
    """`mpu search <pg_ip> --server-number` → номер сервера plain."""
    res = runner.invoke(search.app, ["10.1.0.1", "--server-number", "--no-update"])
    assert res.exit_code == 0
    lines = [ln for ln in res.stdout.splitlines() if ln]
    assert lines == ["1"]
