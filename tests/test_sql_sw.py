"""Тесты sw-PG ветки `mpu sql` (mpu.lib.sql_sw + роутинг в mpu.commands.sql).

sw-PG выполняется ВНУТРИ контейнера sw-back через `pssh` (как `mpu run-js`),
поэтому тесты мокают `pssh.pssh_run` / `pssh.pssh_run_container` и отдают
маркер-строку с JSON-результатом, которую парсит `_extract_payload`.
"""

import io
import json
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import sql as sql_cmd
from mpu.lib import pssh, servers, sql_sw

runner = CliRunner()

MARKER = "__MPU_SW_SQL_RESULT__"


def _write_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(content)
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()


@pytest.fixture
def sw_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    # Пустой .env: дефолтный target=sw-api, dsn из env DATABASE_URL контейнера.
    _write_env(tmp_path, monkeypatch, "")
    yield
    servers.reset_cache()


def _payload(
    cols: list[str], rows: list[list[object]], *, has_result_set: bool = True, rowcount: int = 0
) -> bytes:
    body = {
        "cols": cols,
        "rows": rows,
        "rowCount": rowcount or len(rows),
        "hasResultSet": has_result_set,
    }
    return (MARKER + json.dumps(body) + "\n").encode()


def _fake_pssh_run(
    captured: dict[str, object], stdout_payload: bytes, rc: int = 0
) -> Callable[..., int]:
    def fake(
        *,
        server_number: int,
        cmd: list[str],
        stdin: bytes = b"",
        via: str | None = None,
        on_stdout: Callable[[bytes], None] | None = None,
        on_stderr: Callable[[bytes], None] | None = None,
        manage_signals: bool = True,
    ) -> int:
        captured["server_number"] = server_number
        captured["cmd"] = cmd
        captured["stdin"] = stdin
        if on_stdout is not None:
            on_stdout(stdout_payload)
        return rc

    return fake


def _fake_pssh_container(
    captured: dict[str, object], stdout_payload: bytes, rc: int = 0
) -> Callable[..., int]:
    def fake(
        *,
        container: str,
        cmd: list[str],
        stdin: bytes = b"",
        on_stdout: Callable[[bytes], None] | None = None,
        on_stderr: Callable[[bytes], None] | None = None,
        manage_signals: bool = True,
    ) -> int:
        captured["container"] = container
        captured["stdin"] = stdin
        if on_stdout is not None:
            on_stdout(stdout_payload)
        return rc

    return fake


def test_is_sw_selector() -> None:
    for value in ["sw", "SW", "sw-pg", "SW-PG", "swpg", "ws", "workspaces", "sw-back", " sw "]:
        assert sql_sw.is_sw_selector(value), value
    for value in ["sl-1", "4800", "Тортуга", "swx", "wsx", ""]:
        assert not sql_sw.is_sw_selector(value), value


def test_cli_routes_sw_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_run(sql: str, **kw: object) -> int:
        captured["sql"] = sql
        captured.update(kw)
        return 0

    monkeypatch.setattr(sql_sw, "run_sql_sw", fake_run)
    res = runner.invoke(sql_cmd.app, ["sw", "SELECT 1"])
    assert res.exit_code == 0
    assert captured["sql"] == "SELECT 1"


def test_cli_sw_rejects_server_override(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(sql: str, **kw: object) -> int:  # не должен вызываться
        raise AssertionError("run_sql_sw must not be called")

    monkeypatch.setattr(sql_sw, "run_sql_sw", fake_run)
    res = runner.invoke(sql_cmd.app, ["sw-pg", "SELECT 1", "--server", "sl-1"])
    assert res.exit_code == 2


def test_default_target_container_and_table_output(
    sw_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh,
        "pssh_run_container",
        _fake_pssh_container(captured, _payload(["id", "sid"], [[4800, "abc"]])),
    )

    out = io.StringIO()
    rc = sql_sw.run_sql_sw(
        "SELECT id, sid FROM workspaces_wb_cabinets", stdout=out, stderr=io.StringIO()
    )

    assert rc == 0
    assert captured["container"] == "sw-api"  # дефолтный таргет
    js = bytes(captured["stdin"]).decode()  # type: ignore[arg-type]
    assert 'process.env["DATABASE_URL"]' in js  # DSN берётся из env контейнера
    assert json.dumps("SELECT id, sid FROM workspaces_wb_cabinets") in js
    table = out.getvalue()
    assert "id" in table and "4800" in table and "(1 rows)" in table


def test_custom_target_and_dsn_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_env(
        tmp_path,
        monkeypatch,
        "SW_PG_RUN_TARGET='sl-0'\nSW_PG_DSN_ENV='SW_DATABASE_URL'\n",
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(pssh, "pssh_run", _fake_pssh_run(captured, _payload(["n"], [[1]])))

    rc = sql_sw.run_sql_sw("SELECT 1 AS n", stdout=io.StringIO(), stderr=io.StringIO())

    assert rc == 0
    assert captured["server_number"] == 0  # target sl-0 → pssh_run, не container
    js = bytes(captured["stdin"]).decode()  # type: ignore[arg-type]
    assert 'process.env["SW_DATABASE_URL"]' in js
    servers.reset_cache()


def test_sw_pg_dsn_override_literal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_env(
        tmp_path,
        monkeypatch,
        "SW_PG_DSN='postgresql://u:p@h:5432/workspaces'\n",
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh, "pssh_run_container", _fake_pssh_container(captured, _payload(["n"], [[1]]))
    )

    rc = sql_sw.run_sql_sw("SELECT 1 AS n", stdout=io.StringIO(), stderr=io.StringIO())

    assert rc == 0
    js = bytes(captured["stdin"]).decode()  # type: ignore[arg-type]
    # литерал DSN подставлен вместо чтения env контейнера
    assert json.dumps("postgresql://u:p@h:5432/workspaces") in js
    assert "process.env[" not in js
    servers.reset_cache()


def test_read_only_injects_set_in_esm(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh,
        "pssh_run_container",
        _fake_pssh_container(captured, _payload(["id"], [[4800]])),
    )
    err = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT id FROM t", read_only=True, stdout=io.StringIO(), stderr=err)
    assert rc == 0
    js = bytes(captured["stdin"]).decode()  # type: ignore[arg-type]
    assert "SET default_transaction_read_only = on" in js


def test_no_read_only_omits_set_in_esm(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh,
        "pssh_run_container",
        _fake_pssh_container(captured, _payload(["id"], [[4800]])),
    )
    rc = sql_sw.run_sql_sw("SELECT id FROM t", stdout=io.StringIO(), stderr=io.StringIO())
    assert rc == 0
    js = bytes(captured["stdin"]).decode()  # type: ignore[arg-type]
    assert "default_transaction_read_only" not in js


def test_dry_prints_meta_without_exec(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(**kw: object) -> int:
        raise AssertionError("must not exec on --dry")

    monkeypatch.setattr(pssh, "pssh_run_container", explode)
    err = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT 1", dry=True, stdout=io.StringIO(), stderr=err)
    meta = err.getvalue()
    assert rc == 0
    assert "run_target: sw-api" in meta
    assert "env DATABASE_URL" in meta


def test_no_result_set(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh,
        "pssh_run_container",
        _fake_pssh_container(captured, _payload([], [], has_result_set=False, rowcount=3)),
    )
    out = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT 1", stdout=out, stderr=io.StringIO())
    assert rc == 0
    assert out.getvalue().strip() == "OK (rowcount=3)"


def test_json_output(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        pssh, "pssh_run_container", _fake_pssh_container(captured, _payload(["id"], [[4800]]))
    )
    out = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT id", json_out=True, stdout=out, stderr=io.StringIO())
    assert rc == 0
    assert json.loads(out.getvalue()) == [{"id": 4800}]


def test_exec_failure_surfaces_stderr(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(
        *,
        container: str,
        cmd: list[str],
        stdin: bytes = b"",
        on_stdout: Callable[[bytes], None] | None = None,
        on_stderr: Callable[[bytes], None] | None = None,
        manage_signals: bool = True,
    ) -> int:
        if on_stderr is not None:
            on_stderr(b"some node error\n")
        return 1

    monkeypatch.setattr(pssh, "pssh_run_container", fake)
    err = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT 1", stdout=io.StringIO(), stderr=err)
    assert rc == 1
    assert "some node error" in err.getvalue()


def test_container_resolve_error(sw_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpu.lib import containers

    def fake(**kw: object) -> int:
        raise containers.ContainerResolveError("container 'sw-api' not found in Portainer cache")

    monkeypatch.setattr(pssh, "pssh_run_container", fake)
    err = io.StringIO()
    rc = sql_sw.run_sql_sw("SELECT 1", stdout=io.StringIO(), stderr=err)
    assert rc == 2
    assert "не резолвится" in err.getvalue()
