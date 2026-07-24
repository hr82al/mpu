"""Тесты перехвата fd 1/2 (`mpu.lib.capture`).

Проверяется главное свойство: перехват ловит вывод дочерних процессов и при этом не меняет
природу дескриптора (терминал остаётся терминалом), а на любой ошибке — деградирует.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from mpu.lib import capture

PROBE = (
    "import os, sys;"
    "print('isatty=', sys.stdout.isatty());"
    "print('size=', os.get_terminal_size(1).columns if sys.stdout.isatty() else 'n/a');"
    "print('line1\\nline2')"
)


def _run_probe() -> None:
    subprocess.run([sys.executable, "-c", PROBE], check=True)


def test_pipe_mode_captures_child_output(tmp_path: Path) -> None:
    """stdout — файл (не tty): вывод дочернего процесса и попадает в буфер, и доходит до файла."""
    target = tmp_path / "out.txt"
    saved = os.dup(1)
    with target.open("w") as handle:
        os.dup2(handle.fileno(), 1)
        try:
            with capture.Capture(0) as cap:
                _run_probe()
        finally:
            os.dup2(saved, 1)
            os.close(saved)

    captured = cap.result.out.decode()
    assert "isatty= False" in captured
    assert "line1\nline2" in captured
    assert captured == target.read_text()  # форвард байт-в-байт


def test_pty_mode_keeps_tty_semantics() -> None:
    """stdout — терминал: потомок по-прежнему видит tty, размер окна и `\\n` без `\\r`."""
    import fcntl
    import pty
    import struct
    import termios

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    saved = os.dup(1)
    os.dup2(slave, 1)
    try:
        with capture.Capture(0) as cap:
            _run_probe()
    finally:
        os.dup2(saved, 1)
        os.close(saved)
        os.close(slave)
        os.close(master)

    captured = cap.result.out.decode()
    assert "isatty= True" in captured
    assert "size= 120" in captured
    assert "\r" not in captured  # ONLCR снят — в лог не текут возвраты каретки
    assert capture.real_tty_path() is None  # после выхода состояние сброшено


def test_real_tty_path_exposed_inside_pty_capture() -> None:
    """Пока перехват активен, путь настоящего терминала доступен (нужен term-image)."""
    import pty

    master, slave = pty.openpty()
    expected = os.ttyname(slave)
    saved = os.dup(1)
    os.dup2(slave, 1)
    try:
        with capture.Capture(0):
            inside = capture.real_tty_path()
    finally:
        os.dup2(saved, 1)
        os.close(saved)
        os.close(slave)
        os.close(master)

    assert inside == expected


def test_max_bytes_truncates_and_counts_dropped(tmp_path: Path) -> None:
    """Лимит режет буфер, но считает выброшенное и не мешает выводу дойти до потребителя."""
    target = tmp_path / "out.txt"
    payload = b"x" * 5000
    saved = os.dup(1)
    with target.open("w") as handle:
        os.dup2(handle.fileno(), 1)
        try:
            with capture.Capture(1000) as cap:
                # Пишем в сам дескриптор: под pytest `sys.stdout` подменён и до fd 1 не доходит.
                capture.write_all(1, payload)
        finally:
            os.dup2(saved, 1)
            os.close(saved)

    assert len(cap.result.out) == 1000
    assert cap.result.out_dropped == 4000
    assert len(target.read_text()) == 5000  # потребитель получил всё


def test_stderr_captured_separately(tmp_path: Path) -> None:
    """stdout и stderr не смешиваются — иначе секции записи было бы не различить."""
    out_file, err_file = tmp_path / "o.txt", tmp_path / "e.txt"
    saved_out, saved_err = os.dup(1), os.dup(2)
    with out_file.open("w") as out_handle, err_file.open("w") as err_handle:
        os.dup2(out_handle.fileno(), 1)
        os.dup2(err_handle.fileno(), 2)
        try:
            with capture.Capture(0) as cap:
                subprocess.run(
                    [sys.executable, "-c", "import sys; print('O'); print('E', file=sys.stderr)"],
                    check=True,
                )
        finally:
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            os.close(saved_out)
            os.close(saved_err)

    assert cap.result.out == b"O\n"
    assert cap.result.err == b"E\n"


def test_broken_consumer_propagates_epipe_to_the_writer() -> None:
    """`mpu … | head -1`: потребитель ушёл — писатель обязан получить EPIPE, а не писать никуда."""
    read_fd, write_fd = os.pipe()
    saved = os.dup(1)
    os.dup2(write_fd, 1)
    os.close(write_fd)
    os.close(read_fd)  # потребитель закрылся ещё до вывода
    try:
        with capture.Capture(0):
            capture.write_all(1, b"first\n")  # уходит в перехват, дренаж ловит EPIPE
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    capture.write_all(1, b"second\n")
                except OSError:
                    break  # источник узнал об обрыве — ровно то, что нужно
                time.sleep(0.01)
            else:
                pytest.fail("EPIPE не дошёл до источника")
    finally:
        os.dup2(saved, 1)
        os.close(saved)


def test_capture_degrades_when_fds_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет свободных дескрипторов → работаем без перехвата, команда не страдает."""

    def boom(_fd: int) -> int:
        raise OSError(24, "Too many open files")

    monkeypatch.setattr(os, "dup", boom)
    with capture.Capture(0) as cap:
        print("visible")
    assert cap.result.active is False
    assert cap.result.out == b""


def test_write_all_handles_short_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """`write(2)` вправе вернуть короткий счётчик — дописываем остаток, а не теряем его."""
    written: list[bytes] = []
    real_write = os.write

    def chunked(fd: int, data: "memoryview | bytes") -> int:
        piece = bytes(data)[:3]
        written.append(piece)
        return real_write(fd, piece)

    monkeypatch.setattr(os, "write", chunked)
    read_fd, write_fd = os.pipe()
    try:
        capture.write_all(write_fd, b"abcdefgh")
    finally:
        os.close(write_fd)
        payload = os.read(read_fd, 100)
        os.close(read_fd)

    assert payload == b"abcdefgh"
    assert written == [b"abc", b"def", b"gh"]
