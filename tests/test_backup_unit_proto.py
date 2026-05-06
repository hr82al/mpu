"""Тесты CLI `mpu-backup-wb-unit-proto` и `mpu-backup-ozon-unit-proto`."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import backup_ozon_unit_proto, backup_wb_unit_proto
from mpu.lib import servers, sql_runner, store

runner = CliRunner()


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    env_file = tmp_path / ".env"
    env_file.write_text("sl_1='10.0.0.1'\npg_1='10.1.0.1'\n")
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()

    conn = store.open_store(db_path)
    conn.execute(
        "INSERT INTO sl_clients "
        "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (1311, "sl-1", 1, 0, 0, 100),
    )
    conn.commit()
    conn.close()
    yield
    servers.reset_cache()


def test_wb_dry_emits_expected_sql(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["server"] = server_number
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(backup_wb_unit_proto.app, ["1311", "--date", "20260322", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["server"] == 1
    assert captured["dry"] is True
    assert captured["sql"] == (
        "CREATE TABLE backups.wb_unit_proto_1311_20260322 AS\n"
        "SELECT * FROM schema_1311.wb_unit_proto;"
    )


def test_ozon_dry_emits_expected_sql(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **kw: object) -> int:
        captured["sql"] = sql
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)
    res = runner.invoke(backup_ozon_unit_proto.app, ["1311", "--date", "20260322", "--dry"])
    assert res.exit_code == 0, res.stderr
    assert captured["sql"] == (
        "CREATE TABLE backups.ozon_unit_proto_1311_20260322 AS\n"
        "SELECT * FROM schema_1311.ozon_unit_proto;"
    )


def test_backup_server_override_bypasses_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """С `--server sl-N` SQLite не используется (даже пустой DB подходит)."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    env_file = tmp_path / ".env"
    env_file.write_text("")
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()

    captured: dict[str, object] = {}

    def fake_run(server_number: int, sql: str, **_kw: object) -> int:
        captured["server"] = server_number
        captured["sql"] = sql
        return 0

    monkeypatch.setattr(sql_runner, "run_sql", fake_run)

    res = runner.invoke(
        backup_wb_unit_proto.app,
        ["999", "--date", "20260322", "--server", "sl-5", "--dry"],
    )
    assert res.exit_code == 0, res.stderr
    assert captured["server"] == 5
    sql_val = captured["sql"]
    assert isinstance(sql_val, str)
    assert "schema_999.wb_unit_proto" in sql_val


def _noop_run(*_a: object, **_kw: object) -> int:
    return 0


def test_backup_unknown_client_returns_2(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql_runner, "run_sql", _noop_run)
    res = runner.invoke(backup_wb_unit_proto.app, ["99999", "--dry"])
    assert res.exit_code == 2
    assert "nothing matched" in res.stderr
