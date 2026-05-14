"""Loguru-based file logger для записи вызовов wrapper'а `new-mpu`.

Sink — rotating file в `~/.config/mpu/logs/new-mpu.log`. Console sink выключен,
чтобы не шуметь в stderr пользователя поверх вывода обёрнутой команды.

Путь к файлу можно переопределить через env `MPU_LOG_FILE` (используется в тестах).
"""

from __future__ import annotations

import os
from pathlib import Path

from loguru import logger

__all__ = ["log_file_path", "logger", "setup"]

_DEFAULT_LOG_DIR = Path.home() / ".config" / "mpu" / "logs"
_DEFAULT_LOG_FILE = _DEFAULT_LOG_DIR / "new-mpu.log"

_initialised = False
_log_file: Path | None = None


def log_file_path() -> Path:
    """Resolve лог-файла; env `MPU_LOG_FILE` побеждает дефолт."""
    override = os.environ.get("MPU_LOG_FILE")
    return Path(override).expanduser() if override else _DEFAULT_LOG_FILE


def setup() -> None:
    """Идемпотентно настроить sink'и; повторно вызывать после смены `MPU_LOG_FILE`."""
    global _initialised, _log_file
    target = log_file_path()
    if _initialised and _log_file == target:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    logger.remove()
    logger.add(
        target,
        level="INFO",
        rotation="10 MB",
        retention="30 days",
        compression="gz",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <7} | {message}",
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
    _initialised = True
    _log_file = target


setup()
