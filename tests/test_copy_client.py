"""Тесты `mpu copy-client` (mpu.commands.copy_client) — нативный pg_dump/COPY поверх pg_copy."""

from typing import TypedDict

import pytest
from typer.testing import CliRunner

from mpu.commands import copy_client as cmd
from mpu.lib import pg, pg_copy, sw_seed
from mpu.lib.pg import PgConfigError, PgConn
from mpu.lib.resolver import ResolveError
from pg_fakes import RichConn, patch_popen

runner = CliRunner()


def _stub_seed(
    monkeypatch: pytest.MonkeyPatch, *, login: str = "client_54@local.host", raises: bool = False
) -> None:
    """Подменить sw_seed-швы (проводку sw-front), чтобы тест не ходил в реальный mp-sw-pg."""

    def _cabinets(conn: object, cid: int) -> list[tuple[str, str, str]]:
        return [("sid-1", "Cab", "TM")]

    def _seed(conn: object, cid: int, cabinets: object) -> str:
        if raises:
            raise RuntimeError("sw boom")
        return login

    monkeypatch.setattr(pg, "local_workspaces_conn", lambda: RichConn("sw"))
    monkeypatch.setattr(sw_seed, "read_client_cabinets", _cabinets)
    monkeypatch.setattr(sw_seed, "flush_sw_redis", lambda: None)
    monkeypatch.setattr(sw_seed, "seed_login_workspace", _seed)


def _resolve_to(server: int, candidates: list[dict[str, object]]):
    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return server, candidates

    return _resolve


@pytest.fixture
def fake_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    """resolve_server → server=2, single client_id=54 candidate."""
    monkeypatch.setattr(
        cmd,
        "resolve_server",
        _resolve_to(
            2,
            [
                {
                    "client_id": 54,
                    "server": "sl-2",
                    "title": "Acme",
                    "spreadsheet_id": "ssAcme",
                    "server_number": 2,
                }
            ],
        ),
    )


# --- orchestration: high-level pg_copy швы замокаем, проверяем оркестрацию команды ----


class _Captured(TypedDict):
    schemas: list[tuple[str, str]]  # (schema, src_label)
    public_rows: list[int]
    main_rows: list[int]


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> _Captured:
    calls: _Captured = {"schemas": [], "public_rows": [], "main_rows": []}

    def _dump_restore(src: object, dst: object, schema: str, *, src_label: str) -> None:
        calls["schemas"].append((schema, src_label))

    def _pub(src: object, dst: object, client_id: int, **_: object) -> None:
        calls["public_rows"].append(client_id)

    def _main(src: object, dst: object, client_id: int) -> None:
        calls["main_rows"].append(client_id)

    def _inst(n: int) -> RichConn:
        return RichConn(f"sl-{n}")

    monkeypatch.setattr(pg_copy, "dump_restore_schema", _dump_restore)
    monkeypatch.setattr(pg_copy, "copy_public_rows", _pub)
    monkeypatch.setattr(pg_copy, "copy_main_rows", _main)
    monkeypatch.setattr(pg, "instance_conn", _inst)
    monkeypatch.setattr(pg, "local_sl_conn", lambda: RichConn("loc"))
    monkeypatch.setattr(pg, "local_main_conn", lambda: RichConn("loc"))
    _stub_seed(monkeypatch)
    return calls


def test_happy_path_orchestration(fake_resolve: None, captured: _Captured) -> None:
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert captured["schemas"] == [("schema_54", "sl-2")]  # источник = sl-2
    assert captured["public_rows"] == [54]  # public-строки → sl-1
    assert captured["main_rows"] == [54]  # токен-строки → sl-0
    assert "copy-client 54" in res.output and "sl-2" in res.output
    assert "schema_54 в локальном sl-1: есть — пересоздаю" in res.output
    assert "client 54" in res.output  # финальный ✓
    assert "http://sw.localhost/login → client_54@local.host / 123123" in res.output


def test_resolve_error_bubbles_up(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        raise ResolveError("nothing matched: 'missing'", candidates=[])

    monkeypatch.setattr(cmd, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["missing"])

    assert res.exit_code == 2
    assert "mpu copy-client: nothing matched" in res.output


def test_resolve_error_with_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        raise ResolveError(
            "ambiguous",
            candidates=[{"client_id": 1, "server": "sl-2", "server_number": 2}],
        )

    monkeypatch.setattr(cmd, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "client_id=1" in res.output  # format_candidates напечатан


def test_ambiguous_client_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        cmd,
        "resolve_server",
        _resolve_to(
            2,
            [
                {"client_id": 54, "server": "sl-2", "server_number": 2},
                {"client_id": 55, "server": "sl-2", "server_number": 2},
            ],
        ),
    )
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "matches 2 clients" in res.output


def test_candidates_without_client_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Кандидаты есть, но без числового client_id → _pick_client_id ругается."""
    monkeypatch.setattr(
        cmd, "resolve_server", _resolve_to(2, [{"server": "sl-2", "server_number": 2}])
    )
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "no client_id" in res.output


def test_sl_selector_without_client_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """`mpu copy-client sl-2` — резолвится в сервер без клиента → ошибка."""
    monkeypatch.setattr(cmd, "resolve_server", _resolve_to(2, []))
    res = runner.invoke(cmd.app, ["sl-2"])

    assert res.exit_code == 2
    assert "does not point to a specific client" in res.output


def test_pg_config_error_bubbles_up(fake_resolve: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(n: int) -> PgConn:
        raise PgConfigError("PG host: не найдено pg_2 в ~/.config/mpu/.env")

    monkeypatch.setattr(pg, "instance_conn", _raise)
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 2
    assert "не найдено pg_2" in res.output


# --- full flow: настоящий pg_copy через CLI (швы — pg.*_conn + pg_copy.subprocess.Popen) --


def _patch_conns(
    mp: pytest.MonkeyPatch, *, src: RichConn, local_sl: RichConn, local_main: RichConn
) -> None:
    def _inst(n: int) -> RichConn:
        return src

    mp.setattr(pg, "instance_conn", _inst)
    mp.setattr(pg, "local_sl_conn", lambda: local_sl)
    mp.setattr(pg, "local_main_conn", lambda: local_main)


def test_full_flow_schema_present(fake_resolve: None, monkeypatch: pytest.MonkeyPatch) -> None:
    src = RichConn("sl-2", ss_rows=[], size_row=(7, "12 MB"))  # источник: без своих листов
    local_sl = RichConn("loc", ss_rows=[("ss-old",)], rowcount=2, size_row=(1,))  # схема есть
    local_main = RichConn("loc", rowcount=-1)  # rowcount<0 → «?» строк
    _patch_conns(monkeypatch, src=src, local_sl=local_sl, local_main=local_main)
    patch_popen(monkeypatch)
    _stub_seed(monkeypatch)

    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert "copy-client 54: sl-2" in res.output
    assert "schema_54 в локальном sl-1: есть — пересоздаю из источника" in res.output
    assert "schema_54 на sl-2: 7 таблиц, 12 MB" in res.output  # schema_size источника
    assert "spreadsheets клиента: 0 листов" in res.output  # where_ss обе ветки
    assert "public.clients" in res.output and "public.wb_tokens" in res.output
    assert "2 строк" in res.output and "? строк" in res.output  # rowcount>=0 и <0
    assert "pg_dump schema_54" in res.output and "pg_restore schema_54" in res.output
    assert "права на schema_54 выданы роли client_54" in res.output  # grant clientDB-доступа
    assert "client 54" in res.output
    assert (
        "http://sw.localhost/login → client_54@local.host / 123123" in res.output
    )  # пост-действие


def test_full_flow_schema_absent(fake_resolve: None, monkeypatch: pytest.MonkeyPatch) -> None:
    src = RichConn("sl-2", ss_rows=[("ss-1",)], size_row=(2, "1 MB"))
    # schema_exists fetchone → None («нет»), затем grant role-check → есть (без CREATE/env).
    local_sl = RichConn("loc", ss_rows=[], rowcount=5, fetchone_seq=[None, (1,)])
    local_main = RichConn("loc", rowcount=0)
    _patch_conns(monkeypatch, src=src, local_sl=local_sl, local_main=local_main)
    patch_popen(monkeypatch)
    _stub_seed(monkeypatch)

    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert "schema_54 в локальном sl-1: нет — будет создана из источника" in res.output
    assert "spreadsheets клиента: 1 листов" in res.output  # src ss непустой


def test_seed_failure_is_non_fatal(fake_resolve: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Падение проводки sw-front → WARN, но копия (exit 0) и нет строки входа."""
    src = RichConn("sl-2", ss_rows=[], size_row=(1, "1 MB"))
    local_sl = RichConn("loc", ss_rows=[], rowcount=1, size_row=(1,))
    local_main = RichConn("loc", rowcount=1)
    _patch_conns(monkeypatch, src=src, local_sl=local_sl, local_main=local_main)
    patch_popen(monkeypatch)
    _stub_seed(monkeypatch, raises=True)

    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    assert "WARN проводка sw-front не удалась" in res.output
    assert "http://sw.localhost/login" not in res.output  # входа нет — проводка упала
    assert "client 54" in res.output  # но копия в sl-1 готова
