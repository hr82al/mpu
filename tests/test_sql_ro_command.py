"""Тесты CLI `mpu sql-ro` (mpu.commands.sql_ro) — enforced read-only.

Проверяют, что `sql-ro` прокидывает `read_only=True` во все три ветки исполнения
(normal / dev / sw) и переиспользует резолв селектора из `mpu sql`.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import sql_ro as sql_ro_cmd
from mpu.lib import servers, sql_runner, sql_sw, store

runner = CliRunner()


def _noop_run(*_a: object, **_kw: object) -> int:
    return 0


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    env_file = tmp_path / ".env"
    env_file.write_text("sl_1='10.0.0.1'\nsl_2='10.0.0.2'\npg_1='10.1.0.1'\npg_2='10.1.0.2'\n")
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()

    conn = store.open_store(db_path)
    store.bootstrap(conn)
    conn.executemany(
        "INSERT INTO sl_clients "
        "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(10, "sl-1", 1, 0, 0, 100)],
    )
    conn.commit()
    conn.close()
    yield
    servers.reset_cache()


def test_read_only_passed_through(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["server"] = server_number
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_ro_cmd.app, ["10", "SELECT 1", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["server"] == 1
    assert captured["client_id"] == 10
    assert captured["read_only"] is True


def test_dev_selector_read_only(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_ro_cmd.app, ["dev:10", "SELECT 1", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["dev"] is True
    assert captured["read_only"] is True


def test_sw_selector_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(sql: str, **kw: object) -> int:
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_sw, "run_sql_sw", fake_run)
    res = runner.invoke(sql_ro_cmd.app, ["sw", "SELECT 1"])
    assert res.exit_code == 0
    assert captured["read_only"] is True


def test_empty_sql_returns_2(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(sql_ro_cmd.app, ["10"], input="   \n")
    assert res.exit_code == 2
    assert "empty SQL" in res.stderr


def test_md_and_json_mutually_exclusive(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(sql_ro_cmd.app, ["10", "SELECT 1", "--md", "--json"])
    assert res.exit_code == 2
    assert "mpu sql-ro" in res.stderr
    assert "взаимоисключающие" in res.stderr
