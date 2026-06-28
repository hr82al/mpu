"""Тесты `mpu copy-dev` (mpu.commands.copy_dev) — тонкая команда поверх `lib/pg_copy`."""

from typing import TypedDict

import pytest
from typer.testing import CliRunner

from mpu.commands import copy_dev as cmd
from mpu.lib import pg, pg_copy
from mpu.lib.pg import PgConfigError
from pg_fakes import RichConn, patch_popen

runner = CliRunner()


class _Captured(TypedDict):
    """Перехваченные high-level вызовы `pg_copy`: pg-инструменты + копии строк по client_id."""

    pg_tools: list[tuple[str, list[str]]]  # (label, argv)
    schemas: list[str]  # dump_restore_schema schema
    public_rows: list[int]  # copy_public_rows client_id
    main_rows: list[int]  # copy_main_rows client_id


@pytest.fixture
def fake_conns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pg, "dev_sl_conn", lambda: RichConn("dev"))
    monkeypatch.setattr(pg, "local_sl_conn", lambda: RichConn("loc"))
    monkeypatch.setattr(pg, "local_main_conn", lambda: RichConn("loc"))
    monkeypatch.setattr(pg, "dev_workspaces_conn", lambda: RichConn("dev", dbname="workspaces"))
    monkeypatch.setattr(pg, "local_workspaces_conn", lambda: RichConn("loc", dbname="workspaces"))


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> _Captured:
    calls: _Captured = {"pg_tools": [], "schemas": [], "public_rows": [], "main_rows": []}

    def _tool(argv: list[str], conn: object, label: str, **_: object) -> None:
        calls["pg_tools"].append((label, argv))

    def _dump_restore(src: object, dst: object, schema: str, *, src_label: str) -> None:
        calls["schemas"].append(schema)

    def _pub(src: object, dst: object, client_id: int, **_: object) -> None:
        calls["public_rows"].append(client_id)

    def _main(src: object, dst: object, client_id: int) -> None:
        calls["main_rows"].append(client_id)

    monkeypatch.setattr(pg_copy, "run_pg_tool", _tool)
    monkeypatch.setattr(pg_copy, "dump_restore_schema", _dump_restore)
    monkeypatch.setattr(pg_copy, "copy_public_rows", _pub)
    monkeypatch.setattr(pg_copy, "copy_main_rows", _main)
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
    assert captured["schemas"] == []  # workspaces — без per-client схемы
    assert captured["public_rows"] == [] and captured["main_rows"] == []


def test_client_arg(fake_conns: None, captured: _Captured) -> None:
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert captured["schemas"] == ["schema_54"]  # схема → sl-1 (instance)
    assert captured["public_rows"] == [54]  # public-строки → sl-1
    assert captured["main_rows"] == [54]  # токен-строки → sl-0 (main)
    assert captured["pg_tools"] == []  # для клиента pg-инструменты внутри dump_restore_schema


def test_pg_config_error_bubbles_up(monkeypatch: pytest.MonkeyPatch, captured: _Captured) -> None:
    def _raise() -> pg.PgConn:
        raise PgConfigError("dev workspaces creds: задайте DEV_WORKSPACES_USER")

    monkeypatch.setattr(pg, "dev_workspaces_conn", _raise)
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 2
    assert "DEV_WORKSPACES_USER" in res.output


# --- Полный прогон реального flow через CLI (gоняем настоящие pg_copy.*) ------------
# Подменяем только именованные швы: pg.*_conn (→ RichConn) + pg_copy.subprocess.Popen.


def _patch_conns(
    mp: pytest.MonkeyPatch,
    *,
    dev_sl: RichConn,
    local_sl: RichConn,
    local_main: RichConn,
    dev_ws: RichConn,
    local_ws: RichConn,
) -> None:
    mp.setattr(pg, "dev_sl_conn", lambda: dev_sl)
    mp.setattr(pg, "local_sl_conn", lambda: local_sl)
    mp.setattr(pg, "local_main_conn", lambda: local_main)
    mp.setattr(pg, "dev_workspaces_conn", lambda: dev_ws)
    mp.setattr(pg, "local_workspaces_conn", lambda: local_ws)


def _simple_conns(mp: pytest.MonkeyPatch) -> None:
    _patch_conns(
        mp,
        dev_sl=RichConn("dev"),
        local_sl=RichConn("loc"),
        local_main=RichConn("loc"),
        dev_ws=RichConn("dev"),
        local_ws=RichConn("loc"),
    )


def test_copy_client_full_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    # dev sl — без своих листов (sel_ss → false), локальный sl — со «старым» листом
    # (del_ss → IN(...)): так покрываются ОБЕ ветки where_ss за один прогон.
    dev_sl = RichConn("dev", ss_rows=[], size_row=(7, "12 MB"))
    local_sl = RichConn("loc", ss_rows=[("ss-old",)], rowcount=2)
    local_main = RichConn("loc", rowcount=-1)  # rowcount<0 → «?» строк
    _patch_conns(
        monkeypatch,
        dev_sl=dev_sl,
        local_sl=local_sl,
        local_main=local_main,
        dev_ws=RichConn("dev"),
        local_ws=RichConn("loc"),
    )
    patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert "schema_54 на dev: 7 таблиц, 12 MB" in res.output  # schema_size + src_label
    assert "spreadsheets клиента: 0 листов" in res.output  # dev_ss пуст → where_ss false
    assert "public.clients" in res.output and "public.wb_tokens" in res.output
    assert "2 строк" in res.output  # local_sl rowcount=2 (shown>=0)
    assert "? строк" in res.output  # local_main rowcount<0 (shown="?")
    assert "client 54" in res.output  # финальный отчёт
    assert "pg_dump schema_54" in res.output and "pg_restore schema_54" in res.output
    assert "progress" in res.output  # строка прогресса из потока _pump


def test_copy_client_schema_size_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    # fetchone → None: ветка `if not row` в schema_size (best-effort заглушка)
    _patch_conns(
        monkeypatch,
        dev_sl=RichConn("dev", size_row=None),
        local_sl=RichConn("loc"),
        local_main=RichConn("loc"),
        dev_ws=RichConn("dev"),
        local_ws=RichConn("loc"),
    )
    patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, ["7"])

    assert res.exit_code == 0, res.output
    assert "размер неизвестен" in res.output


def test_copy_workspaces_full_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    patch_popen(monkeypatch)

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "pg_dump workspaces" in res.output and "pg_restore workspaces" in res.output
    assert "готово за" in res.output  # успешный run_pg_tool
    assert "workspaces скопирована" in res.output


def test_run_pg_tool_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    patch_popen(monkeypatch, timeouts=1)  # первый wait() → TimeoutExpired → heartbeat-строка

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "работаю, прошло" in res.output


def test_run_pg_tool_failure_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    _simple_conns(monkeypatch)
    patch_popen(monkeypatch, rc=1)  # pg_dump падает → typer.Exit(1)

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 1
    assert "pg_dump workspaces failed" in res.output
