"""Перехват stdout/stderr на время одного вызова `mpu` — сырьё для лога (`lib/log.py`).

Подменяются **сами дескрипторы** 1 и 2, а не `sys.stdout`/`sys.stderr`: заметная часть
вывода приходит от дочерних процессов (`ssh`, `docker exec`, `pg_dump`, `docker compose`),
которые пишут прямо в fd и питоновской подменой не ловятся.

Природа дескриптора сохраняется, чтобы поведение команды не изменилось:

- fd был терминалом → `pty.openpty()`: потомки и `rich` по-прежнему видят `isatty() == True`,
  размер окна копируется, `ONLCR` на слейве снимается (иначе в лог попадут `\\r`);
- fd был пайпом/файлом → `os.pipe()`: потомок и так видел не-tty.

Перехват fail-open: любая ошибка означает «работаем без перехвата», команда не страдает.
Единственное известное отличие от жизни без перехвата — момент доставки `EPIPE`: писатель
узнаёт об оборвавшемся потребителе не на том же `write`, а на следующем.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import pty
import struct
import sys
import termios
import threading
from dataclasses import dataclass

__all__ = ["Capture", "CapturedStreams", "real_tty_path", "write_all"]

_READ_CHUNK = 65536
_JOIN_TIMEOUT_SECONDS = 2.0

# Путь к настоящему терминалу пользователя, снятый ДО подмены fd. Нужен библиотекам,
# которые ищут терминал через `ttyname(1)` (см. `lib/kaiten_render.py` и term-image).
_real_tty_path: str | None = None


def real_tty_path() -> str | None:
    """Терминал пользователя до подмены fd; `None` — перехвата нет или fd был не tty."""
    return _real_tty_path


def write_all(fd: int, data: bytes) -> None:
    """Записать буфер целиком: `write(2)` вправе вернуть короткий счётчик без исключения."""
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:  # защита от вечного цикла на патологическом ядре/ФС
            break
        view = view[written:]


@dataclass(frozen=True)
class CapturedStreams:
    """Итог перехвата: сырые байты потоков и сколько байт не влезло в лимит."""

    out: bytes
    err: bytes
    out_dropped: int
    err_dropped: int
    active: bool


def _disable_onlcr(fd: int) -> None:
    """Снять NL→CR-NL на слейве pty: перевод строки должен доехать до лога как `\\n`."""
    with contextlib.suppress(OSError, termios.error):
        attrs = termios.tcgetattr(fd)
        attrs[1] = attrs[1] & ~termios.ONLCR
        termios.tcsetattr(fd, termios.TCSANOW, attrs)


def _copy_winsize(src_fd: int, dst_fd: int) -> None:
    """Перенести размер окна настоящего терминала на pty — иначе `rich` посчитает 80 колонок."""
    with contextlib.suppress(OSError):
        packed = fcntl.ioctl(src_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(dst_fd, termios.TIOCSWINSZ, packed)


class _StreamCapture:
    """Перехват одного дескриптора: pty либо пайп + поток-дренаж (форвард + буфер)."""

    def __init__(self, fd: int, max_bytes: int) -> None:
        self.fd = fd
        self.max_bytes = max_bytes
        self.buffer = bytearray()
        self.dropped = 0
        self.tty_path: str | None = None
        self._saved_fd = -1
        self._read_fd = -1
        self._write_fd = -1
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Подменить дескриптор и поднять дренаж. OSError наружу → вызывающий деградирует."""
        self._saved_fd = os.dup(self.fd)
        try:
            if os.isatty(self.fd):
                with contextlib.suppress(OSError):  # имя устройства — бонус, не условие
                    self.tty_path = os.ttyname(self.fd)
                self._read_fd, self._write_fd = pty.openpty()
                _disable_onlcr(self._write_fd)
                _copy_winsize(self.fd, self._write_fd)
            else:
                self._read_fd, self._write_fd = os.pipe()
            os.dup2(self._write_fd, self.fd)
        except OSError:
            self._close_pair()
            os.close(self._saved_fd)
            self._saved_fd = -1
            raise
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Вернуть настоящий дескриптор, дождаться дренажа, закрыть свои fd."""
        if self._saved_fd < 0:
            return
        with contextlib.suppress(OSError):
            os.dup2(self._saved_fd, self.fd)
        # Закрытие своей стороны даёт дренажу EOF (пайп) либо EIO (мастер pty).
        if self._write_fd >= 0:
            with contextlib.suppress(OSError):
                os.close(self._write_fd)
            self._write_fd = -1
        if self._thread is not None:
            self._thread.join(timeout=_JOIN_TIMEOUT_SECONDS)
            self._thread = None
        if self._read_fd >= 0:
            with contextlib.suppress(OSError):
                os.close(self._read_fd)
            self._read_fd = -1
        with contextlib.suppress(OSError):
            os.close(self._saved_fd)
        self._saved_fd = -1

    def _close_pair(self) -> None:
        for attr in ("_read_fd", "_write_fd"):
            fd = getattr(self, attr)
            if fd >= 0:
                with contextlib.suppress(OSError):
                    os.close(fd)
                setattr(self, attr, -1)

    def _drain(self) -> None:
        """Читать подменённый поток: копить в буфер и форвардить в настоящий дескриптор."""
        while True:
            try:
                chunk = os.read(self._read_fd, _READ_CHUNK)
            except OSError:
                return  # EIO от мастера pty после закрытия слейва — штатный EOF
            if not chunk:
                return
            self._append(chunk)
            try:
                write_all(self._saved_fd, chunk)
            except OSError:
                # Потребитель закрылся (`mpu … | head -1`). Закрываем read-конец, чтобы
                # источник получил EPIPE на следующей записи — как и без перехвата.
                read_fd, self._read_fd = self._read_fd, -1
                with contextlib.suppress(OSError):
                    os.close(read_fd)
                return

    def _append(self, chunk: bytes) -> None:
        if self.max_bytes <= 0:  # 0 = без обрезки (явное решение пользователя)
            self.buffer.extend(chunk)
            return
        room = max(self.max_bytes - len(self.buffer), 0)
        if room:
            self.buffer.extend(chunk[:room])
        if len(chunk) > room:
            self.dropped += len(chunk) - room


class Capture:
    """Контекст-менеджер перехвата fd 1/2 на время вызова.

    `max_bytes` — предел на поток (0 = без обрезки). Результат — в `result` после выхода.
    """

    def __init__(self, max_bytes: int) -> None:
        self._out = _StreamCapture(1, max_bytes)
        self._err = _StreamCapture(2, max_bytes)
        self._active = False
        self.result = CapturedStreams(b"", b"", 0, 0, active=False)

    def __enter__(self) -> Capture:
        _flush_std()
        try:
            self._out.start()
            self._err.start()
        except OSError:
            # Дескрипторы кончились / pty не выделился — работаем без перехвата.
            self._out.stop()
            self._err.stop()
            return self
        self._active = True
        global _real_tty_path
        _real_tty_path = self._out.tty_path
        return self

    def __exit__(self, *_exc: object) -> None:
        if not self._active:
            return
        _flush_std()
        try:
            self._out.stop()
            self._err.stop()
        finally:
            global _real_tty_path
            _real_tty_path = None
            self._active = False
        self.result = CapturedStreams(
            bytes(self._out.buffer),
            bytes(self._err.buffer),
            self._out.dropped,
            self._err.dropped,
            active=True,
        )


def _flush_std() -> None:
    """Слить питоновские буферы: иначе непрослитое утечёт в чужую запись (или мимо неё)."""
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(OSError, ValueError):
            stream.flush()
