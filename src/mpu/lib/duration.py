"""Парсер relative-duration строк (`10m`, `1h`, `30s`, `2d`) в Unix-timestamp.

Используется `mpup-logs --since` и `mpu p health --since` для unified-семантики.
"""

import re
import time

_SINCE_RE = re.compile(r"\A(\d+)([smhd])\Z")
_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


class DurationParseError(ValueError):
    """Невалидный формат duration; строковое сообщение пригодно для CLI-вывода."""


def parse_since(s: str) -> int:
    """`10m` / `1h` / `30s` / `2d` → Unix-ts (now - delta). Чистое число → принимаем как есть."""
    if s.isdigit():
        return int(s)
    m = _SINCE_RE.fullmatch(s)
    if not m:
        raise DurationParseError(
            f"ожидается <число>{{s|m|h|d}} или unix-ts, получено {s!r}"
        )
    n = int(m.group(1))
    unit = m.group(2)
    return int(time.time()) - _SECONDS[unit] * n
