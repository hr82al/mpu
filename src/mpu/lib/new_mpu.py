"""Прокси-обёртка для запуска `new-mpu <subcommand> *argv` с логированием вызовов.

Используется тонкими command-модулями `mpu.commands.{sheet,xlsx,db}`. После
полного переноса этих команд в нативный Python внутри `mpu` модуль удаляется.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Iterable
from pathlib import Path
from typing import IO

from mpu.lib.log import logger

__all__ = ["run_new_mpu"]

_HEAD_LINES = 10
_TAIL_LINES = 20


def run_new_mpu(subcommand: str, argv: Iterable[str]) -> int:
    """Запустить `new-mpu <subcommand> *argv`, проксируя stdin/stdout/stderr.

    Возвращает exit code дочернего процесса. Логирует argv, cwd, duration, rc и
    head/tail stdout/stderr в файл (см. `mpu.lib.log`).
    """
    args = list(argv)
    binary = shutil.which("new-mpu")
    cmd_repr = " ".join(["new-mpu", subcommand, *args])

    if binary is None:
        msg = "new-mpu not found in PATH"
        logger.error(f"{cmd_repr}\n  rc=127  ({msg})")
        print(f"mpu: {msg}", file=sys.stderr)
        return 127

    cwd = Path.cwd()
    start = time.perf_counter()

    proc = subprocess.Popen(
        [binary, subcommand, *args],
        stdin=sys.stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    stdout_capture = _StreamCapture()
    stderr_capture = _StreamCapture()
    # `text=True` + PIPE гарантирует, что proc.stdout/stderr — текстовые потоки.
    assert proc.stdout is not None
    assert proc.stderr is not None
    t_out = threading.Thread(
        target=_tee, args=(proc.stdout, sys.stdout, stdout_capture), daemon=True
    )
    t_err = threading.Thread(
        target=_tee, args=(proc.stderr, sys.stderr, stderr_capture), daemon=True
    )
    t_out.start()
    t_err.start()

    try:
        rc = proc.wait()
    except KeyboardInterrupt:
        # SIGINT уже доставлен child'у через общую process group; ждём аккуратного выхода.
        rc = proc.wait()

    t_out.join()
    t_err.join()

    duration = time.perf_counter() - start
    level = "INFO" if rc == 0 else ("WARNING" if rc > 0 else "ERROR")
    message = (
        f"{cmd_repr}\n"
        f"  cwd={cwd}\n"
        f"  duration={duration:.3f}s  rc={rc}\n"
        f"  stdout:\n{_indent(stdout_capture.excerpt())}\n"
        f"  stderr:\n{_indent(stderr_capture.excerpt())}"
    )
    logger.log(level, message)
    return rc


class _StreamCapture:
    """Накапливает head и tail прочитанных строк для лога."""

    def __init__(self) -> None:
        self.head: list[str] = []
        self.tail: deque[str] = deque(maxlen=_TAIL_LINES)
        self.total: int = 0

    def add(self, line: str) -> None:
        self.total += 1
        if len(self.head) < _HEAD_LINES:
            self.head.append(line)
        self.tail.append(line)

    def excerpt(self) -> str:
        if self.total == 0:
            return "(empty)"
        if self.total <= _HEAD_LINES + _TAIL_LINES:
            # Всё уместилось в head; tail только повторил бы хвост head'а.
            return "\n".join(self.head if self.total <= _HEAD_LINES else list(self.tail))
        truncated = self.total - _HEAD_LINES - _TAIL_LINES
        return (
            "\n".join(self.head)
            + f"\n... ({truncated} lines truncated) ...\n"
            + "\n".join(self.tail)
        )


def _tee(src: IO[str], dst: IO[str], capture: _StreamCapture) -> None:
    """Стримит строки из src в dst (с flush) и параллельно копит для лога."""
    for line in src:
        dst.write(line)
        dst.flush()
        capture.add(line.rstrip("\n"))


def _indent(text: str, prefix: str = "    ") -> str:
    return "\n".join(prefix + ln for ln in text.splitlines()) if text else prefix + "(empty)"
