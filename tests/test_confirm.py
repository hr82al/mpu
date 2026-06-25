"""Unit-тесты `mpu confirm` — y/N gate в pipe (`commands/confirm.py`).

Тестируем приватные хелперы (`_tty_path`/`_ask_tty`/`_tty_diagnostics`/`_NoTtyError`)
и CLI-контракт `main`: на `y`/`yes` буфер уходит в stdout, на `n`/EOF/нет-tty — ничего
не пишется и ненулевой exit. Терминал и stdin замоканы — без реального tty/сети.
"""
# Тестируем underscore-хелперы tty-слоя (_tty_path/_ask_tty/_tty_diagnostics/_NoTtyError).
# pyright: reportPrivateUsage=false

import pytest
from typer.testing import CliRunner

from mpu.commands import confirm

runner = CliRunner()


# ── CLI: _ask_tty замокан целиком (CliRunner подменяет stdin/stdout/stderr) ────


def _install_ask(monkeypatch: pytest.MonkeyPatch, *, answer: bool, calls: list[str]) -> None:
    """Подменить `_ask_tty` фейком, который пишет message в `calls` и возвращает answer."""

    def _fake(message: str) -> bool:
        calls.append(message)
        return answer

    monkeypatch.setattr(confirm, "_ask_tty", _fake)


def test_yes_passes_stdin_to_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    """`y` → буфер целиком уходит в stdout (и дублируется в stderr для обзора)."""
    calls: list[str] = []
    _install_ask(monkeypatch, answer=True, calls=calls)
    result = runner.invoke(confirm.app, [], input="line1\nline2\n")
    assert result.exit_code == 0, result.output
    assert result.stdout == "line1\nline2\n"
    assert result.stderr == "line1\nline2\n"
    assert calls == ["Применить?"]  # дефолтный текст подтверждения


def test_custom_message_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    """`-m` пробрасывается в _ask_tty как текст подтверждения."""
    calls: list[str] = []
    _install_ask(monkeypatch, answer=True, calls=calls)
    result = runner.invoke(confirm.app, ["-m", "Залить?"], input="x\n")
    assert result.exit_code == 0, result.output
    assert calls == ["Залить?"]


def test_no_aborts_pipe_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    """`n`/прочее → ничего в stdout, exit 1, в stderr — пометка об отмене."""
    calls: list[str] = []
    _install_ask(monkeypatch, answer=False, calls=calls)
    result = runner.invoke(confirm.app, [], input="data\n")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert "отменено" in result.stderr
    assert "data\n" in result.stderr  # буфер всё равно показан в stderr


def test_no_tty_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет терминала (_NoTtyError) → exit 2, подсказка про `--yes`/two-step, пусто в stdout."""

    def _no_tty(_message: str) -> bool:
        raise confirm._NoTtyError

    monkeypatch.setattr(confirm, "_ask_tty", _no_tty)
    result = runner.invoke(confirm.app, [], input="data\n")
    assert result.exit_code == 2
    assert result.stdout == ""
    assert "терминал недоступен" in result.stderr
    assert "--yes" in result.stderr


def test_assume_yes_skips_ask(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--yes` пропускает буфер без вопроса — _ask_tty не дёргается."""

    def _must_not_ask(_message: str) -> bool:
        raise AssertionError("--yes must not call _ask_tty")

    monkeypatch.setattr(confirm, "_ask_tty", _must_not_ask)
    result = runner.invoke(confirm.app, ["--yes"], input="payload\n")
    assert result.exit_code == 0, result.output
    assert result.stdout == "payload\n"


def test_assume_yes_short_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """`-y` — короткая форма `--yes`."""

    def _must_not_ask(_message: str) -> bool:
        raise AssertionError("-y must not call _ask_tty")

    monkeypatch.setattr(confirm, "_ask_tty", _must_not_ask)
    result = runner.invoke(confirm.app, ["-y"], input="p")
    assert result.exit_code == 0, result.output
    assert result.stdout == "p"


def test_empty_input_yes() -> None:
    """Пустой stdin + `--yes` → пустой stdout; в stderr только добавленный перевод строки."""
    result = runner.invoke(confirm.app, ["--yes"], input="")
    assert result.exit_code == 0, result.output
    assert result.stdout == ""
    assert result.stderr == "\n"


def test_no_trailing_newline_stdout_faithful() -> None:
    """stdout байт-в-байт (без дописанного \\n), а в stderr перевод строки добавляется."""
    result = runner.invoke(confirm.app, ["--yes"], input="abc")
    assert result.exit_code == 0, result.output
    assert result.stdout == "abc"  # ничего не дописано в проходящий буфер
    assert result.stderr == "abc\n"  # перевод строки только в обзорный stderr


def test_trailing_newline_not_doubled() -> None:
    """Если буфер уже кончается \\n — лишний перевод строки в stderr не добавляется."""
    result = runner.invoke(confirm.app, ["--yes"], input="abc\n")
    assert result.exit_code == 0, result.output
    assert result.stderr == "abc\n"


def test_idempotent_repeat_yes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Два прогона с тем же входом дают идентичный результат (нет скрытого состояния)."""
    calls: list[str] = []
    _install_ask(monkeypatch, answer=True, calls=calls)
    first = runner.invoke(confirm.app, [], input="same\n")
    second = runner.invoke(confirm.app, [], input="same\n")
    assert first.exit_code == second.exit_code == 0
    assert first.stdout == second.stdout == "same\n"


# ── _ask_tty: разбор ответа из сырого os.read ────────────────────────────────


def _patch_ask_os(monkeypatch: pytest.MonkeyPatch, *, response: bytes, writes: list[bytes]) -> None:
    """Замокать tty-слой `_ask_tty`: путь есть, os.read → `response`, write → `writes`."""

    def _path() -> str | None:
        return "/dev/tty"

    def _open(_path: str, _flags: int) -> int:
        return 7

    def _write(_fd: int, data: bytes) -> int:
        writes.append(data)
        return len(data)

    def _read(_fd: int, _n: int) -> bytes:
        return response

    def _close(_fd: int) -> None:
        return None

    monkeypatch.setattr(confirm, "_tty_path", _path)
    monkeypatch.setattr(confirm.os, "open", _open)
    monkeypatch.setattr(confirm.os, "write", _write)
    monkeypatch.setattr(confirm.os, "read", _read)
    monkeypatch.setattr(confirm.os, "close", _close)


@pytest.mark.parametrize(
    "response,expected",
    [
        (b"y\n", True),
        (b"yes\n", True),
        (b"Y\n", True),  # регистр снимается .lower()
        (b"YES", True),
        (b"  y  \n", True),  # .strip()
        (b"n\n", False),
        (b"no\n", False),  # «no» НЕ в ("y","yes") → отмена
        (b"", False),  # EOF
        (b"\xff\xfe", False),  # мусор → decode replace → не y/yes
        (b"maybe", False),
    ],
)
def test_ask_tty_parses_answer(
    monkeypatch: pytest.MonkeyPatch, response: bytes, expected: bool
) -> None:
    writes: list[bytes] = []
    _patch_ask_os(monkeypatch, response=response, writes=writes)
    assert confirm._ask_tty("Apply?") is expected
    assert writes == [b"Apply? [y/N] "]


def test_ask_tty_encodes_unicode_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    """Кириллический message кодируется в utf-8 при записи в tty."""
    writes: list[bytes] = []
    _patch_ask_os(monkeypatch, response=b"y", writes=writes)
    assert confirm._ask_tty("Применить?") is True
    assert writes == ["Применить? [y/N] ".encode()]


def test_ask_tty_no_path_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет пути к терминалу → _NoTtyError (наследник OSError)."""

    def _no_path() -> str | None:
        return None

    monkeypatch.setattr(confirm, "_tty_path", _no_path)
    assert issubclass(confirm._NoTtyError, OSError)
    with pytest.raises(confirm._NoTtyError):
        confirm._ask_tty("x")


def test_ask_tty_closes_fd_on_read_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """os.read падает → finally всё равно закрывает дескриптор."""
    closed: list[int] = []

    def _path() -> str | None:
        return "/dev/tty"

    def _open(_path: str, _flags: int) -> int:
        return 9

    def _write(_fd: int, data: bytes) -> int:
        return len(data)

    def _read(_fd: int, _n: int) -> bytes:
        raise OSError("read fail")

    def _close(fd: int) -> None:
        closed.append(fd)

    monkeypatch.setattr(confirm, "_tty_path", _path)
    monkeypatch.setattr(confirm.os, "open", _open)
    monkeypatch.setattr(confirm.os, "write", _write)
    monkeypatch.setattr(confirm.os, "read", _read)
    monkeypatch.setattr(confirm.os, "close", _close)
    with pytest.raises(OSError, match="read fail"):
        confirm._ask_tty("x")
    assert closed == [9]


# ── _tty_path: выбор источника терминала ─────────────────────────────────────


def test_tty_path_returns_dev_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    """controlling /dev/tty открывается → берём его."""

    def _open(path: str, _flags: int) -> int:
        assert path == "/dev/tty"
        return 5

    def _close(_fd: int) -> None:
        return None

    monkeypatch.setattr(confirm.os, "open", _open)
    monkeypatch.setattr(confirm.os, "close", _close)
    assert confirm._tty_path() == "/dev/tty"


def test_tty_path_falls_back_to_std_fd(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет /dev/tty, но stdout (fd 1) — tty → ttyname(1)."""

    def _open_fail(_path: str, _flags: int) -> int:
        raise OSError("no /dev/tty")

    def _isatty(fd: int) -> bool:
        return fd == 1

    def _ttyname(_fd: int) -> str:
        return "/dev/pts/3"

    monkeypatch.setattr(confirm.os, "open", _open_fail)
    monkeypatch.setattr(confirm.os, "isatty", _isatty)
    monkeypatch.setattr(confirm.os, "ttyname", _ttyname)
    assert confirm._tty_path() == "/dev/pts/3"


def test_tty_path_none_when_no_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ни /dev/tty, ни один std-fd не tty → None."""

    def _open_fail(_path: str, _flags: int) -> int:
        raise OSError

    def _isatty(_fd: int) -> bool:
        return False

    monkeypatch.setattr(confirm.os, "open", _open_fail)
    monkeypatch.setattr(confirm.os, "isatty", _isatty)
    assert confirm._tty_path() is None


def test_tty_path_isatty_oserror_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    """os.isatty на битом fd кидает OSError → ветка continue, итог None."""

    def _open_fail(_path: str, _flags: int) -> int:
        raise OSError

    def _isatty_raises(_fd: int) -> bool:
        raise OSError("bad fd")

    monkeypatch.setattr(confirm.os, "open", _open_fail)
    monkeypatch.setattr(confirm.os, "isatty", _isatty_raises)
    assert confirm._tty_path() is None


# ── _tty_diagnostics: человекочитаемая сводка по fd 0/1/2 + /dev/tty ──────────


def test_tty_diagnostics_ok_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    """/dev/tty доступен и fd2 — tty: в сводке OK-строка и ttyname."""

    def _open(_path: str, _flags: int) -> int:
        return 4

    def _close(_fd: int) -> None:
        return None

    def _isatty(fd: int) -> bool:
        return fd == 2

    def _ttyname(_fd: int) -> str:
        return "/dev/pts/9"

    monkeypatch.setattr(confirm.os, "open", _open)
    monkeypatch.setattr(confirm.os, "close", _close)
    monkeypatch.setattr(confirm.os, "isatty", _isatty)
    monkeypatch.setattr(confirm.os, "ttyname", _ttyname)
    out = confirm._tty_diagnostics()
    assert "/dev/tty: OK (os.open)" in out
    assert "fd0 stdin:" in out
    assert "fd1 stdout:" in out
    assert "fd2 stderr:" in out
    assert "isatty=True" in out  # fd2
    assert "/dev/pts/9" in out


def test_tty_diagnostics_error_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    """/dev/tty недоступен и ttyname падает: ошибки попадают в сводку текстом."""

    def _open_fail(_path: str, _flags: int) -> int:
        raise OSError("denied")

    def _isatty(_fd: int) -> bool:
        return False

    def _ttyname_fail(_fd: int) -> str:
        raise OSError("not a tty")

    monkeypatch.setattr(confirm.os, "open", _open_fail)
    monkeypatch.setattr(confirm.os, "isatty", _isatty)
    monkeypatch.setattr(confirm.os, "ttyname", _ttyname_fail)
    out = confirm._tty_diagnostics()
    assert "denied" in out  # ветка ошибки /dev/tty
    assert "not a tty" in out  # ошибка ttyname вписана в строку fd
    assert "isatty=False" in out
