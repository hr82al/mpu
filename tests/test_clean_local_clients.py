"""Тесты `mpu clean-local-clients` (mpu.commands.clean_local_clients)."""

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import clean_local_clients as cmd
from mpu.lib import local_clean, pg
from mpu.lib.pg import PgConfigError
from pg_fakes import RichConn

runner = CliRunner()


def _patch(monkeypatch: pytest.MonkeyPatch, *, all_ids: list[int], removed: int = 0) -> None:
    monkeypatch.setattr(pg, "local_sl_conn", lambda: RichConn("sl"))
    monkeypatch.setattr(pg, "local_main_conn", lambda: RichConn("main"))
    monkeypatch.setattr(pg, "local_workspaces_conn", lambda: RichConn("ws"))

    def _ids(conn: object) -> list[int]:
        return all_ids

    def _clean(sl: object, main: object, ws: object, targets: list[int]) -> int:
        return removed

    monkeypatch.setattr(local_clean, "local_client_ids", _ids)
    monkeypatch.setattr(local_clean, "clean_clients", _clean)


def test_parse_keep() -> None:
    assert cmd.parse_keep("54, 776") == {54, 776}
    assert cmd.parse_keep("") == set()


def test_parse_keep_bad() -> None:
    with pytest.raises(typer.BadParameter):
        cmd.parse_keep("54,abc")


def test_dry_run_is_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, all_ids=[54, 103, 279])
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "под удаление: [103, 279]" in res.output
    assert "сухой прогон" in res.output  # ничего не удалено без --yes


def test_nothing_to_delete(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, all_ids=[54, 776])
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "нечего удалять" in res.output


def test_execute_with_yes(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, all_ids=[54, 103], removed=1)
    res = runner.invoke(cmd.app, ["--yes"])

    assert res.exit_code == 0, res.output
    assert "удалено 1 клиент" in res.output and "снято 1 workspace" in res.output


def test_custom_keep(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, all_ids=[54, 103, 279])
    res = runner.invoke(cmd.app, ["--keep", "103"])

    assert res.exit_code == 0, res.output
    assert "под удаление: [54, 279]" in res.output  # 103 в keep, 54 больше нет


def test_pg_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> pg.PgConn:
        raise PgConfigError("local sl password: не задано")

    monkeypatch.setattr(pg, "local_sl_conn", _boom)
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 2
    assert "local sl password" in res.output
