"""Тесты `mpu copy-dev` (mpu.commands.copy_dev)."""

from typing import TypedDict

import pytest
from typer.testing import CliRunner

from mpu.commands import copy_dev as cmd
from mpu.lib import pg
from mpu.lib.pg import PgConfigError

runner = CliRunner()

# Лог вызовов `_FakeCursor`/`_FakeDb`: ("execute", sql) | ("commit",) и т.п.
_LogRow = tuple[str, ...]


class _Captured(TypedDict):
    """Перехваченные в фикстуре `captured` вызовы pg-инструментов и копирований строк."""

    pg_tools: list[tuple[str, list[str]]]  # (label, argv)
    public_rows: list[int]  # client_id
    main_rows: list[int]  # client_id


class _FakeCursor:
    def __init__(self, log: list[_LogRow]) -> None:
        self._log = log

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        self._log.append(("execute", sql))


class _FakeDb:
    def __init__(self, log: list[_LogRow]) -> None:
        self._log = log

    def __enter__(self) -> "_FakeDb":
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self._log)

    def commit(self) -> None:
        self._log.append(("commit",))


class _FakeConn:
    """Подмена `PgConn` — даёт атрибуты для argv и no-op `.connect()`."""

    def __init__(self, host: str, port: str, dbname: str) -> None:
        self.host = host
        self.port = port
        self.dbname = dbname
        self.user = "u"
        self.password = "p"
        self.db_log: list[_LogRow] = []

    def connect(self, **_: object) -> _FakeDb:
        return _FakeDb(self.db_log)


@pytest.fixture
def fake_conns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pg, "dev_sl_conn", lambda: _FakeConn("dev", "5434", "mp_sl_1_dev"))
    monkeypatch.setattr(pg, "local_sl_conn", lambda: _FakeConn("loc", "5441", "wb"))
    monkeypatch.setattr(pg, "local_main_conn", lambda: _FakeConn("loc", "5440", "wb"))
    monkeypatch.setattr(pg, "dev_workspaces_conn", lambda: _FakeConn("dev", "5432", "workspaces"))
    monkeypatch.setattr(pg, "local_workspaces_conn", lambda: _FakeConn("loc", "5451", "workspaces"))


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> _Captured:
    calls: _Captured = {"pg_tools": [], "public_rows": [], "main_rows": []}

    def _tool(argv: list[str], conn: object, label: str) -> None:
        calls["pg_tools"].append((label, argv))

    def _pub(src: object, dst: object, client_id: int) -> None:
        calls["public_rows"].append(client_id)

    def _main(src: object, dst: object, client_id: int) -> None:
        calls["main_rows"].append(client_id)

    monkeypatch.setattr(cmd, "_run_pg_tool", _tool)
    monkeypatch.setattr(cmd, "_copy_public_rows", _pub)
    monkeypatch.setattr(cmd, "_copy_main_rows", _main)
    return calls


def test_workspaces_no_arg(fake_conns: None, captured: _Captured) -> None:
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    labels = [lbl for lbl, _ in captured["pg_tools"]]
    assert labels == ["pg_dump workspaces", "pg_restore workspaces"]
    dump_argv = captured["pg_tools"][0][1]
    assert "pg_dump" in dump_argv and "workspaces" in dump_argv
    assert "--no-acl" in dump_argv and "-Fc" in dump_argv
    restore_argv = captured["pg_tools"][1][1]
    assert "pg_restore" in restore_argv
    assert "--clean" in restore_argv and "--if-exists" in restore_argv
    assert captured["public_rows"] == []  # workspaces — без per-client public-строк
    assert captured["main_rows"] == []  # workspaces — без токен-строк на sl-0


def test_client_arg(fake_conns: None, captured: _Captured) -> None:
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    labels = [lbl for lbl, _ in captured["pg_tools"]]
    assert labels == ["pg_dump schema_54", "pg_restore schema_54"]
    dump_argv = captured["pg_tools"][0][1]
    assert "-n" in dump_argv and "schema_54" in dump_argv
    assert "--no-owner" in dump_argv and "--no-privileges" in dump_argv
    assert captured["public_rows"] == [54]  # схема+public-строки → sl-1 (instance)
    assert captured["main_rows"] == [54]  # токен-строки → sl-0 (main)


def test_pg_config_error_bubbles_up(monkeypatch: pytest.MonkeyPatch, captured: _Captured) -> None:
    def _raise() -> pg.PgConn:
        raise PgConfigError("dev workspaces creds: задайте DEV_WORKSPACES_USER")

    monkeypatch.setattr(pg, "dev_workspaces_conn", _raise)
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 2
    assert "DEV_WORKSPACES_USER" in res.output
