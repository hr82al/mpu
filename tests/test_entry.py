"""Тесты обёртки вызова (`mpu.entry` + `mpu.lib.log.invocation_log`).

Вызовы делаются in-process (как `tests/test_cli.py`), чтобы попадать в покрытие:
прогоны через subprocess его не считают (`pytest-cov` не выставляет `COVERAGE_PROCESS_START`).
"""

import sys
from pathlib import Path

import pytest

from mpu import entry
from mpu.lib import log


def _run(argv: list[str], monkeypatch: pytest.MonkeyPatch) -> int:
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(SystemExit) as exit_info:
        entry.main()
    code = exit_info.value.code
    return code if isinstance(code, int) else 1


def _log_text() -> str:
    path = log.log_file_path()
    return path.read_text(encoding="utf-8") if path.exists() else ""


def test_successful_call_writes_one_record(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _run(["mpu", "version"], monkeypatch) == 0
    text = _log_text()
    assert text.count("--- end run=") == 1
    assert text.splitlines()[1] == "$ mpu version"  # ровно строка команды, без пути к бинарю
    assert "exit=0" in text


def test_failing_call_records_exit_code_and_stderr(
    monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    # Перехват работает на уровне дескрипторов, поэтому собственный fd-перехват pytest
    # на время вызова снимаем — иначе вывод команды до наших дескрипторов не доедет.
    with capfd.disabled():
        code = _run(["mpu", "bogus-command"], monkeypatch)
    assert code == 2
    text = _log_text()
    assert "--- err run=" in text
    assert "No such command" in text
    assert "exit=2" in text


def test_shell_completion_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Иначе каждое нажатие TAB оставляло бы запись в логе."""
    monkeypatch.setenv("_MPU_COMPLETE", "complete_fish")
    _run(["mpu", "version"], monkeypatch)
    assert not log.log_file_path().exists()


def test_kill_switch_skips_logging_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    """`MPU_LOG_ENABLED=0`: ни файла, ни подмены дескрипторов."""
    monkeypatch.setenv("MPU_LOG_ENABLED", "0")
    before = sys.stdout
    assert _run(["mpu", "version"], monkeypatch) == 0
    assert sys.stdout is before
    assert not log.log_file_path().exists()


def test_unhandled_exception_is_logged_with_traceback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Traceback печатает интерпретатор уже после восстановления fd — форматируем сами."""
    monkeypatch.setattr(sys, "argv", ["mpu", "version"])
    monkeypatch.setenv("MPU_LOG_FILE", str(tmp_path / "boom.log"))

    def boom() -> None:
        raise RuntimeError("сломалось на импорте")

    monkeypatch.setattr("mpu.cli.main", boom)
    with pytest.raises(RuntimeError):
        entry.main()

    text = (tmp_path / "boom.log").read_text(encoding="utf-8")
    assert "RuntimeError: сломалось на импорте" in text
    assert "exit=1" in text


def test_no_capture_command_is_recorded_without_output_sections(
    monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]
) -> None:
    """`mpu log` не перехватывается — иначе лог удваивал бы сам себя."""
    with capfd.disabled():
        _run(["mpu", "version"], monkeypatch)  # обычная команда: вывод в логе есть
        _run(["mpu", "log", "--tail", "1"], monkeypatch)

    version_record, log_record = _log_text().split("\n\n")[:2]
    assert "--- out run=" in version_record
    assert log_record.splitlines()[1] == "$ mpu log --tail 1"
    assert "--- out run=" not in log_record
    assert "--- err run=" not in log_record


def test_string_exit_code_is_recorded_as_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """`sys.exit("сообщение")`: код 1, а сам текст — в секции ошибок."""
    monkeypatch.setattr(sys, "argv", ["mpu", "version"])

    def bail() -> None:
        raise SystemExit("что-то пошло не так")

    monkeypatch.setattr("mpu.cli.main", bail)
    with pytest.raises(SystemExit):
        entry.main()

    text = _log_text()
    assert "exit=1" in text
    assert "что-то пошло не так" in text
