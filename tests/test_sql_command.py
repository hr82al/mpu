"""Тесты CLI `mpu sql` (mpu.commands.sql)."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import sql as sql_cmd
from mpu.lib import servers, sql_runner, store

runner = CliRunner()


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
        [
            (10, "sl-1", 1, 0, 0, 100),
            (20, "sl-2", 1, 0, 0, 100),
        ],
    )
    conn.executemany(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("ssA", 10, "Тортуга main", "tmpl", 1, "sl-1", 100),
            ("ssB", 20, "Тортуга side", "tmpl", 1, "sl-2", 100),
        ],
    )
    conn.commit()
    conn.close()
    yield
    servers.reset_cache()


def test_dry_with_explicit_sql_arg(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["server"] = server_number
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_cmd.app, ["10", "SELECT 1", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["server"] == 1
    assert captured["sql"] == "SELECT 1"
    assert captured["dry"] is True
    assert captured["client_id"] == 10


def test_sql_from_stdin(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_cmd.app, ["10", "--dry"], input="SELECT now()\n")
    assert res.exit_code == 0, res.stderr
    sql_val = captured["sql"]
    assert isinstance(sql_val, str)
    assert sql_val.strip() == "SELECT now()"


def _noop_run(*_a: object, **_kw: object) -> int:
    return 0


def test_ambiguous_selector(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_kw: object) -> int:
        raise AssertionError("run_sql must not be called on ambiguity")

    monkeypatch.setattr(sql_runner, "run_sql", boom)
    res = runner.invoke(sql_cmd.app, ["Тортуга", "SELECT 1"])
    assert res.exit_code == 2
    assert "ambiguous" in res.stderr
    assert "client_id=10" in res.stderr
    assert "client_id=20" in res.stderr


def test_empty_sql_returns_2(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(sql_cmd.app, ["10"], input="   \n")
    assert res.exit_code == 2
    assert "empty SQL" in res.stderr


def test_server_override_skips_resolver(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["server"] = server_number
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_cmd.app, ["doesnt-matter", "SELECT 1", "--server", "sl-7", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["server"] == 7
    assert captured["client_id"] is None


def test_nothing_matched(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(sql_cmd.app, ["NOTHING_HERE", "SELECT 1"])
    assert res.exit_code == 2
    assert "nothing matched" in res.stderr


def test_md_flag_passed_through(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(sql_cmd.app, ["10", "SELECT 1", "--md", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["md_out"] is True
    assert captured["json_out"] is False


def test_md_and_json_mutually_exclusive(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(sql_cmd.app, ["10", "SELECT 1", "--md", "--json"])
    assert res.exit_code == 2
    assert "взаимоисключающие" in res.stderr
