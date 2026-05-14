"""Тесты passthrough-обёрток `mpu sheet|xlsx|db` → `new-mpu <sub>` (mpu.lib.new_mpu)."""

from __future__ import annotations

import io
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu import cli as root_cli
from mpu.commands import sheet as sheet_cmd
from mpu.commands import xlsx as xlsx_cmd
from mpu.lib import log as log_module
from mpu.lib import new_mpu

runner = CliRunner()


class FakePopen:
    """Минимальный double для subprocess.Popen — текстовые stdout/stderr из строк."""

    def __init__(
        self,
        args: list[str],
        stdout_text: str = "",
        stderr_text: str = "",
        rc: int = 0,
        **_kw: object,
    ) -> None:
        self.args = args
        self.stdout: io.StringIO | None = io.StringIO(stdout_text)
        self.stderr: io.StringIO | None = io.StringIO(stderr_text)
        self.returncode = rc

    def wait(self) -> int:
        return self.returncode


@pytest.fixture
def log_to_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    log_file = tmp_path / "new-mpu.log"
    monkeypatch.setenv("MPU_LOG_FILE", str(log_file))
    monkeypatch.setattr(log_module, "_initialised", False)
    monkeypatch.setattr(log_module, "_log_file", None)
    log_module.setup()
    yield log_file
    # После теста — сбросить sink'и, иначе loguru держит open file.
    log_module.logger.remove()
    monkeypatch.setattr(log_module, "_initialised", False)


def _patch_popen(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict[str, object],
    stdout: str = "",
    stderr: str = "",
    rc: int = 0,
) -> None:
    def _which(_name: str) -> str:
        return "/usr/bin/new-mpu"

    monkeypatch.setattr(new_mpu.shutil, "which", _which)

    def _factory(args: list[str], **kw: object) -> FakePopen:
        captured["args"] = args
        captured["kwargs"] = kw
        return FakePopen(args, stdout_text=stdout, stderr_text=stderr, rc=rc)

    monkeypatch.setattr(subprocess, "Popen", _factory)


def test_sheet_passthrough_forwards_argv_and_rc(
    monkeypatch: pytest.MonkeyPatch, log_to_tmp: Path
) -> None:
    captured: dict[str, object] = {}
    _patch_popen(monkeypatch, captured, stdout="row1\nrow2\n", rc=0)

    res = runner.invoke(sheet_cmd.app, ["get", "ID", "A1:B10"])

    assert res.exit_code == 0
    assert captured["args"] == ["/usr/bin/new-mpu", "sheet", "get", "ID", "A1:B10"]
    log_text = log_to_tmp.read_text()
    assert "new-mpu sheet get ID A1:B10" in log_text
    assert "rc=0" in log_text
    assert "row1" in log_text


def test_xlsx_passthrough_propagates_nonzero_rc(
    monkeypatch: pytest.MonkeyPatch, log_to_tmp: Path
) -> None:
    captured: dict[str, object] = {}
    _patch_popen(monkeypatch, captured, stderr="boom\n", rc=2)

    res = runner.invoke(xlsx_cmd.app, ["get", "--file", "a.xlsx", "Sheet1!A:B"])

    assert res.exit_code == 2
    assert captured["args"] == [
        "/usr/bin/new-mpu",
        "xlsx",
        "get",
        "--file",
        "a.xlsx",
        "Sheet1!A:B",
    ]
    log_text = log_to_tmp.read_text()
    assert "rc=2" in log_text
    assert "WARNING" in log_text
    assert "boom" in log_text


def test_db_passthrough_via_root_app_forwards_help_flag(
    monkeypatch: pytest.MonkeyPatch, log_to_tmp: Path
) -> None:
    captured: dict[str, object] = {}
    _patch_popen(monkeypatch, captured, stdout="(help)\n", rc=0)

    # Проверка реального пути `mpu db …` через root Typer-app: _mount() должен
    # сохранить context_settings обёртки, иначе Click перехватит `--help`.
    res = runner.invoke(root_cli.app, ["db", "query", "sl-1", "--help"])

    assert res.exit_code == 0, res.output
    assert captured["args"] == ["/usr/bin/new-mpu", "db", "query", "sl-1", "--help"]


def test_missing_binary_returns_127_and_logs_error(
    monkeypatch: pytest.MonkeyPatch, log_to_tmp: Path
) -> None:
    def _which_missing(_name: str) -> str | None:
        return None

    monkeypatch.setattr(new_mpu.shutil, "which", _which_missing)

    rc = new_mpu.run_new_mpu("sheet", ["get", "ID"])

    assert rc == 127
    log_text = log_to_tmp.read_text()
    assert "ERROR" in log_text
    assert "new-mpu not found" in log_text
    assert "rc=127" in log_text


def test_excerpt_truncates_long_output(
    monkeypatch: pytest.MonkeyPatch, log_to_tmp: Path
) -> None:
    captured: dict[str, object] = {}
    long_stdout = "".join(f"line {i}\n" for i in range(100))
    _patch_popen(monkeypatch, captured, stdout=long_stdout, rc=0)

    res = runner.invoke(sheet_cmd.app, ["get", "ID", "A1"])

    assert res.exit_code == 0
    log_text = log_to_tmp.read_text()
    assert "lines truncated" in log_text
    assert "line 0" in log_text  # head
    assert "line 99" in log_text  # tail
