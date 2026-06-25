"""Тесты `mpu copy-dev` (mpu.commands.copy_dev)."""

import subprocess
from collections.abc import Iterator
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


# --- Полный прогон реального flow через CLI ---------------------------------------
# Гоняем НАСТОЯЩИЕ _copy_client / _copy_workspaces / _run_pg_tool / _seed_rows /
# _replace_rows / _ss_ids / _where_ss / _schema_size через публичный CLI, подменяя
# только именованные швы: pg.*_conn (как fake_conns) + subprocess.Popen. Так
# покрываются ветки, которые фикстура `captured` обходит, замокав helper'ы целиком.


class _FakePopen:
    """Подмена `subprocess.Popen`: отдаёт строки прогресса и заданный код возврата.

    `timeouts` штук первых `wait()` бросают `TimeoutExpired` (ветка heartbeat),
    затем возвращается `rc`.
    """

    def __init__(self, *, lines: list[str], rc: int, timeouts: int) -> None:
        self.stdout: list[str] = list(lines)
        self._rc = rc
        self._timeouts_left = timeouts

    def wait(self, timeout: float | None = None) -> int:
        if self._timeouts_left > 0:
            self._timeouts_left -= 1
            raise subprocess.TimeoutExpired(cmd="pg", timeout=timeout or 0.0)
        return self._rc


class _RichCopy:
    """COPY-объект psycopg: и читается (итерация блоков, COPY TO), и пишется (COPY FROM)."""

    def __init__(self, blocks: list[bytes], log: list[_LogRow]) -> None:
        self._blocks = blocks
        self._log = log

    def __enter__(self) -> "_RichCopy":
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._blocks)

    def write(self, block: bytes) -> None:
        self._log.append(("write", repr(block)))


class _RichCursor:
    def __init__(self, conn: "_RichConn") -> None:
        self._conn = conn
        self.rowcount = conn.rowcount

    def __enter__(self) -> "_RichCursor":
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def execute(self, query: object, params: object = None) -> None:
        self._conn.log.append(("execute", type(query).__name__))

    def fetchone(self) -> tuple[object, ...] | None:
        return self._conn.size_row

    def fetchall(self) -> list[tuple[str, ...]]:
        return self._conn.ss_rows

    def copy(self, query: object) -> _RichCopy:
        self._conn.log.append(("copy", type(query).__name__))
        return _RichCopy(self._conn.blocks, self._conn.log)


class _RichDb:
    def __init__(self, conn: "_RichConn") -> None:
        self._conn = conn

    def __enter__(self) -> "_RichDb":
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def cursor(self) -> _RichCursor:
        return _RichCursor(self._conn)

    def commit(self) -> None:
        self._conn.log.append(("commit", ""))


class _RichConn:
    """PgConn-подобный фейк: атрибуты для argv + `.connect()` с полным cursor/COPY-протоколом.

    - `ss_rows` — что вернёт `_ss_ids` (fetchall) на этом коннекте;
    - `size_row` — что вернёт `_schema_size` (fetchone); `None` → ветка «размер неизвестен»;
    - `rowcount` — `cursor.rowcount` после COPY (отрицательный → «?» строк в выводе).
    """

    def __init__(
        self,
        host: str,
        *,
        ss_rows: list[tuple[str, ...]] | None = None,
        size_row: tuple[object, ...] | None = (3, "1 MB"),
        blocks: list[bytes] | None = None,
        rowcount: int = 2,
    ) -> None:
        self.host = host
        self.port = "5432"
        self.user = "u"
        self.dbname = "db"
        self.password = "p"
        self.ss_rows: list[tuple[str, ...]] = ss_rows if ss_rows is not None else []
        self.size_row = size_row
        self.blocks: list[bytes] = blocks if blocks is not None else [b"r\n"]
        self.rowcount = rowcount
        self.log: list[_LogRow] = []

    def connect(self, **_: object) -> _RichDb:
        return _RichDb(self)


def _patch_conns(
    mp: pytest.MonkeyPatch,
    *,
    dev_sl: _RichConn,
    local_sl: _RichConn,
    local_main: _RichConn,
    dev_ws: _RichConn,
    local_ws: _RichConn,
) -> None:
    mp.setattr(pg, "dev_sl_conn", lambda: dev_sl)
    mp.setattr(pg, "local_sl_conn", lambda: local_sl)
    mp.setattr(pg, "local_main_conn", lambda: local_main)
    mp.setattr(pg, "dev_workspaces_conn", lambda: dev_ws)
    mp.setattr(pg, "local_workspaces_conn", lambda: local_ws)


def _patch_popen(
    mp: pytest.MonkeyPatch,
    *,
    rc: int = 0,
    lines: tuple[str, ...] = ("progress\n",),
    timeouts: int = 0,
) -> None:
    def _make(argv: list[str], **_: object) -> _FakePopen:
        return _FakePopen(lines=list(lines), rc=rc, timeouts=timeouts)

    mp.setattr(cmd.subprocess, "Popen", _make)


def _simple_conns(mp: pytest.MonkeyPatch) -> None:
    """Все пять коннектов — дефолтные `_RichConn` (когда детали БД-протокола неважны)."""
    _patch_conns(
        mp,
        dev_sl=_RichConn("dev"),
        local_sl=_RichConn("loc"),
        local_main=_RichConn("loc"),
        dev_ws=_RichConn("dev"),
        local_ws=_RichConn("loc"),
    )


def test_copy_client_full_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    # dev sl — без своих листов (sel_ss → false), локальный sl — со «старым» листом
    # (del_ss → IN(...)): так покрываются ОБЕ ветки _where_ss за один прогон.
    dev_sl = _RichConn("dev", ss_rows=[], size_row=(7, "12 MB"))
    local_sl = _RichConn("loc", ss_rows=[("ss-old",)], rowcount=2)
    local_main = _RichConn("loc", rowcount=-1)  # rowcount<0 → «?» строк
    _patch_conns(
        monkeypatch,
        dev_sl=dev_sl,
        local_sl=local_sl,
        local_main=local_main,
        dev_ws=_RichConn("dev"),
        local_ws=_RichConn("loc"),
    )
    _patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert "7 таблиц, 12 MB" in res.output  # _schema_size — успешная ветка
    assert "spreadsheets клиента: 0 листов" in res.output  # dev_ss пуст → _where_ss false
    assert "public.clients" in res.output and "public.wb_tokens" in res.output
    assert "2 строк" in res.output  # local_sl rowcount=2 (shown>=0)
    assert "? строк" in res.output  # local_main rowcount<0 (shown="?")
    assert "client 54" in res.output  # финальный отчёт _copy_client
    # реальный _run_pg_tool отработал dump+restore через фейковый Popen
    assert "pg_dump schema_54" in res.output and "pg_restore schema_54" in res.output
    assert "progress" in res.output  # строка прогресса из потока _pump


def test_copy_client_schema_size_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    # fetchone → None: ветка `if not row` в _schema_size (best-effort заглушка)
    _patch_conns(
        monkeypatch,
        dev_sl=_RichConn("dev", size_row=None),
        local_sl=_RichConn("loc"),
        local_main=_RichConn("loc"),
        dev_ws=_RichConn("dev"),
        local_ws=_RichConn("loc"),
    )
    _patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, ["7"])

    assert res.exit_code == 0, res.output
    assert "размер неизвестен" in res.output


def test_copy_workspaces_full_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    _patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "pg_dump workspaces" in res.output and "pg_restore workspaces" in res.output
    assert "готово за" in res.output  # успешный _run_pg_tool
    assert "workspaces скопирована" in res.output


def test_run_pg_tool_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    _patch_popen(monkeypatch, timeouts=1)  # первый wait() → TimeoutExpired → heartbeat-строка

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "работаю, прошло" in res.output


def test_run_pg_tool_failure_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    _patch_popen(monkeypatch, rc=1)  # pg_dump падает → typer.Exit(1)

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 1
    assert "pg_dump workspaces failed" in res.output
