"""Тесты команды просмотра журнала вызовов (`mpu log`)."""

from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import log as log_cmd

runner = CliRunner()


def _record(
    run_id: str, command: str, *, exit_code: int = 0, ts: str = "2026-07-21 16:39:12.345"
) -> str:
    return (
        f"### {ts} +03:00 run={run_id} pid=1 cwd=/tmp\n"
        f"$ {command}\n"
        f"--- out run={run_id} ---\n"
        f"полезный вывод\n"
        f"--- end run={run_id} exit={exit_code} dur=0.100s ---\n\n"
    )


@pytest.fixture
def log_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "mpu.log"
    path.write_text(
        _record("r1", "mpu version")
        + _record("r2", "mpu sql-ro 1973 'select 1'", exit_code=2)
        + _record("r3", "mpu sheet get x"),
        encoding="utf-8",
    )
    monkeypatch.setenv("MPU_LOG_FILE", str(path))
    return path


def test_tail_shows_last_records(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--tail", "2"])
    assert result.exit_code == 0
    assert "$ mpu version" not in result.stdout
    assert "$ mpu sheet get x" in result.stdout


def test_failed_filters_by_exit_code(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--failed"])
    assert result.exit_code == 0
    assert "$ mpu sql-ro" in result.stdout
    assert "$ mpu version" not in result.stdout


def test_cmd_filters_by_command_prefix(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--cmd", "sheet get"])
    assert "$ mpu sheet get x" in result.stdout
    assert "$ mpu sql-ro" not in result.stdout


def test_run_prints_single_record_verbatim(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--run", "r2"])
    assert result.exit_code == 0
    assert result.stdout == _record("r2", "mpu sql-ro 1973 'select 1'", exit_code=2)


def test_unknown_run_fails_with_machine_readable_error(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--run", "нет-такого"])
    assert result.exit_code == 1
    assert "mpu log: запись run=нет-такого не найдена" in result.output


def test_since_rejects_garbage(log_file: Path) -> None:
    result = runner.invoke(log_cmd.app, ["--since", "вчера"])
    assert result.exit_code == 2
    assert "mpu log: --since:" in result.output


def test_since_keeps_only_fresh_records(log_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import datetime, timedelta

    fresh = (datetime.now().astimezone() - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S.%f")[
        :-3
    ]
    log_file.write_text(
        _record("old", "mpu version", ts="2020-01-01 10:00:00.000")
        + _record("new", "mpu sheet get x", ts=fresh),
        encoding="utf-8",
    )
    result = runner.invoke(log_cmd.app, ["--since", "10m"])
    assert "$ mpu sheet get x" in result.stdout
    assert "$ mpu version" not in result.stdout


def test_reads_whole_rotated_set(log_file: Path) -> None:
    """Записи могли уехать в архив ротацией — просмотр обязан видеть их тоже."""
    Path(f"{log_file}.1").write_text(_record("r0", "mpu ps"), encoding="utf-8")
    result = runner.invoke(log_cmd.app, ["--tail", "10"])
    assert result.stdout.index("$ mpu ps") < result.stdout.index("$ mpu version")  # старые сверху


def test_explicit_file_overrides_the_set(log_file: Path, tmp_path: Path) -> None:
    other = tmp_path / "other.log"
    other.write_text(_record("z1", "mpu health"), encoding="utf-8")
    result = runner.invoke(log_cmd.app, ["--file", str(other)])
    assert "$ mpu health" in result.stdout
    assert "$ mpu version" not in result.stdout


def test_empty_log_reports_nothing_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MPU_LOG_FILE", str(tmp_path / "absent.log"))
    result = runner.invoke(log_cmd.app, [])
    assert result.exit_code == 0
    assert "записей не найдено" in result.output


def test_marker_lookalike_inside_output_does_not_split_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Внутри вывода может оказаться текст, похожий на маркер: спасает сверка `run=`."""
    path = tmp_path / "mpu.log"
    path.write_text(
        "### 2026-07-21 16:39:12.345 +03:00 run=real pid=1 cwd=/tmp\n"
        "$ mpu log --tail 1\n"
        "--- out run=real ---\n"
        "### 2026-07-21 10:00:00.000 +03:00 run=fake pid=9 cwd=/tmp\n"
        "$ mpu bogus\n"
        "--- end run=fake exit=1 dur=0.000s ---\n"
        "--- end run=real exit=0 dur=0.100s ---\n\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MPU_LOG_FILE", str(path))
    records = log_cmd.parse_records(path.read_text(encoding="utf-8"))
    assert [record.run_id for record in records] == ["real"]
    assert records[0].exit_code == 0
