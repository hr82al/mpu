"""Тесты proxy-dispatch команды `mpu xlsx` → `run_new_mpu("xlsx", ...)`.

Здесь мокается сам runner (`mpu.lib.new_mpu.run_new_mpu`), а не subprocess —
проверяется только проброс subcommand/argv и exit code из тонкой обёртки
`mpu.commands.xlsx`. Поведение самого runner покрыто в `test_new_mpu_wrapper.py`.
"""

from __future__ import annotations

from collections.abc import Iterable

import pytest
from typer.testing import CliRunner

from mpu.commands import xlsx as xlsx_cmd

runner = CliRunner()


def _patch_runner(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, object], rc: int = 0
) -> None:
    def _fake_run(subcommand: str, argv: Iterable[str]) -> int:
        captured["subcommand"] = subcommand
        captured["argv"] = list(argv)
        return rc

    monkeypatch.setattr(xlsx_cmd, "run_new_mpu", _fake_run)


def test_xlsx_dispatches_subcommand_and_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    _patch_runner(monkeypatch, captured, rc=0)

    res = runner.invoke(xlsx_cmd.app, ["get", "--file", "a.xlsx", "Sheet1!A:B"])

    assert res.exit_code == 0
    assert captured["subcommand"] == "xlsx"
    assert captured["argv"] == ["get", "--file", "a.xlsx", "Sheet1!A:B"]


def test_xlsx_propagates_nonzero_rc(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    _patch_runner(monkeypatch, captured, rc=3)

    res = runner.invoke(xlsx_cmd.app, ["bogus-subcommand"])

    assert res.exit_code == 3
    assert captured["argv"] == ["bogus-subcommand"]


def test_xlsx_no_args_passes_empty_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    _patch_runner(monkeypatch, captured, rc=0)

    res = runner.invoke(xlsx_cmd.app, [])

    assert res.exit_code == 0
    assert captured["subcommand"] == "xlsx"
    assert captured["argv"] == []
