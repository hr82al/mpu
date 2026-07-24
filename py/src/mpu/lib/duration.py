"""Парсеры длительностей: `parse_since` (→ Unix-ts) и `parse_minutes` (→ минуты).

- `parse_since` — relative-duration (`10m`, `1h`, `30s`, `2d`) в момент времени «now - delta».
  Используется `mpup-logs --since` и `mpu p health --since` для unified-семантики.
- `parse_minutes` — длительность работы (`3h`, `1h15m`, `1:15`, `90`, `2.5h`) в целые минуты.
  Используется `mpu kiten time` (учёт времени Kaiten, где единица API — минута).

⚠️ **Эти два парсера НЕ объединять и не сводить к общему.** На одинаковом входе они означают
противоположное: `parse_since("90")` — это unix-ts 90 (абсолютный момент), `parse_minutes("90")`
— это 90 минут (длительность). Общая у них только `DurationParseError`.
"""

import math
import re
import time

_SINCE_RE = re.compile(r"\A(\d+)([smhd])\Z")
_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

# Ч:ММ — минутная часть валидируется отдельно, чтобы отличить «1:60» от полного мусора.
_CLOCK_RE = re.compile(r"\A(\d{1,3}):(\d{1,2})\Z")
# Составная форма: пары «число + единица», единицы латиницей и кириллицей, регистр не важен.
_UNIT_RE = re.compile(r"(\d+(?:[.,]\d+)?)([hmчм])")
_BARE_RE = re.compile(r"\A\d+(?:[.,]\d+)?\Z")
_MINUTES_PER = {"h": 60, "ч": 60, "m": 1, "м": 1}

MAX_LOG_MINUTES = 24 * 60
_FORMS_HINT = "3h | 1h15m | 1:15 | 90 (минуты) | 2.5h"


class DurationParseError(ValueError):
    """Невалидный формат duration; строковое сообщение пригодно для CLI-вывода."""


def parse_since(s: str) -> int:
    """`10m` / `1h` / `30s` / `2d` → Unix-ts (now - delta). Чистое число → принимаем как есть."""
    if s.isdigit():
        return int(s)
    m = _SINCE_RE.fullmatch(s)
    if not m:
        raise DurationParseError(f"ожидается <число>{{s|m|h|d}} или unix-ts, получено {s!r}")
    n = int(m.group(1))
    unit = m.group(2)
    return int(time.time()) - _SECONDS[unit] * n


def _parse_clock(raw: str) -> int | None:
    """`Ч:ММ` → минуты. Не эта форма → None; минутная часть вне 00–59 → ошибка."""
    m = _CLOCK_RE.fullmatch(raw)
    if m is None:
        return None
    hours, minutes = int(m.group(1)), int(m.group(2))
    if minutes > 59:  # noqa: PLR2004 — граница минутной части часов, не «магия»
        raise DurationParseError(f"{raw!r}: минуты в форме Ч:ММ должны быть 00–59")
    return hours * 60 + minutes


def _parse_units(raw: str) -> int | None:
    """`1h15m` / `2.5h` / `45м` → минуты. Не эта форма (или остаток) → None.

    Единицы латиницей и кириллицей, порядок свободен, каждая не чаще раза. Дробные части
    округляются ВВЕРХ — паритет с Kaiten, который округляет длительность таймера вверх до минуты.
    """
    matches = list(_UNIT_RE.finditer(raw))
    if not matches or "".join(m.group(0) for m in matches) != raw:
        return None  # мусор между парами или хвост без единицы («1h15») — не наша форма
    units = [m.group(2) for m in matches]
    if len(set(units)) != len(units):
        return None
    total = sum(float(m.group(1).replace(",", ".")) * _MINUTES_PER[m.group(2)] for m in matches)
    return math.ceil(total)


def parse_minutes(raw: str) -> int:
    """`3h` / `1h15m` / `1:15` / `90` (голое = минуты) / `2.5h` → целые минуты (≥ 1).

    Регистр и внутренние пробелы не важны; десятичный разделитель — точка или запятая.
    Секунды намеренно не поддерживаются: логировать 40 секунд работы незачем, а лишняя
    единица размазала бы округление вверх по всей грамматике.

    Ноль, отрицательные и больше `MAX_LOG_MINUTES` (24 ч) отвергаются: и то и другое —
    почти наверняка опечатка, а не намерение.
    """
    cleaned = "".join(raw.split()).lower()
    if not cleaned:
        raise DurationParseError(f"{raw!r}: пустая длительность; ожидается {_FORMS_HINT}")

    minutes = _parse_clock(cleaned)
    if minutes is None:
        minutes = _parse_units(cleaned)
    if minutes is None and _BARE_RE.fullmatch(cleaned):
        minutes = math.ceil(float(cleaned.replace(",", ".")))
    if minutes is None:
        # Частая опечатка: число без единицы в хвосте составной формы («1h15»).
        if _UNIT_RE.match(cleaned) and cleaned[-1].isdigit():
            raise DurationParseError(
                f"{raw!r}: после числа нужна единица измерения — "
                f"вероятно, вы имели в виду '{cleaned}m'"
            )
        raise DurationParseError(f"{raw!r}: неразобранная длительность; ожидается {_FORMS_HINT}")

    if minutes <= 0:
        raise DurationParseError(f"{raw!r}: нулевая длительность бессмысленна")
    if minutes > MAX_LOG_MINUTES:
        raise DurationParseError(
            f"{raw!r}: больше 24 ч в одной записи; заведите записи по дням через --date"
        )
    return minutes


def format_minutes(total: int) -> str:
    """Минуты → человекочитаемое `1 ч 15 мин` / `45 мин` / `2 ч`."""
    hours, minutes = divmod(total, 60)
    if hours and minutes:
        return f"{hours} ч {minutes} мин"
    if hours:
        return f"{hours} ч"
    return f"{minutes} мин"
