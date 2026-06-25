"""Тесты `parse_since` в `lib/duration.py` — relative-duration → Unix-ts.

`time.time` замокан фиксированным значением, чтобы относительные сдвиги
(`30s`/`10m`/`2h`/`7d`) были детерминированы.
"""

import pytest

from mpu.lib.duration import DurationParseError, parse_since

# Фиксированный "сейчас" — ровный unix-ts, чтобы expected считались очевидно.
_NOW = 1_700_000_000


@pytest.fixture
def frozen_time(monkeypatch: pytest.MonkeyPatch) -> int:
    """Замораживает `time.time()` на `_NOW`; возвращает это значение."""
    monkeypatch.setattr("mpu.lib.duration.time.time", lambda: float(_NOW))
    return _NOW


# --- numeric unix-ts passthrough ------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0", 0),
        ("1", 1),
        ("12345", 12345),
        ("1700000000", 1_700_000_000),
        ("007", 7),  # ведущие нули — isdigit True, int() их съедает
    ],
)
def test_pure_digits_passthrough(raw: str, expected: int) -> None:
    # numeric-вход возвращается как есть, БЕЗ обращения к time.time
    assert parse_since(raw) == expected


def test_pure_digits_does_not_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    # чистое число не должно дёргать time.time — патчим на взрыв
    def _boom() -> float:
        raise AssertionError("time.time() не должен вызываться для numeric-входа")

    monkeypatch.setattr("mpu.lib.duration.time.time", _boom)
    assert parse_since("42") == 42


# --- relative durations ----------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "delta"),
    [
        ("30s", 30),
        ("1s", 1),
        ("10m", 10 * 60),
        ("1m", 60),
        ("2h", 2 * 3600),
        ("1h", 3600),
        ("7d", 7 * 86400),
        ("1d", 86400),
        ("0s", 0),  # ноль секунд → ровно now
        ("0d", 0),
    ],
)
def test_relative_subtracts_from_now(raw: str, delta: int, frozen_time: int) -> None:
    assert parse_since(raw) == frozen_time - delta


def test_all_supported_suffixes(frozen_time: int) -> None:
    # явная проверка набора суффиксов s|m|h|d и их множителей
    assert parse_since("1s") == frozen_time - 1
    assert parse_since("1m") == frozen_time - 60
    assert parse_since("1h") == frozen_time - 3600
    assert parse_since("1d") == frozen_time - 86400


def test_large_count(frozen_time: int) -> None:
    # большой множитель не переполняется и считается арифметически
    assert parse_since("1000000d") == frozen_time - 1_000_000 * 86400


def test_time_truncated_to_int(monkeypatch: pytest.MonkeyPatch) -> None:
    # float now усекается int() до вычитания
    monkeypatch.setattr("mpu.lib.duration.time.time", lambda: 1_700_000_000.987)
    assert parse_since("10s") == 1_700_000_000 - 10


# --- error paths -----------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "",  # пусто
        "abc",  # буквы
        "m",  # суффикс без числа
        "10",  # это уже numeric-ветка? нет — "10".isdigit() True, не сюда (см. ниже)
        "10x",  # неизвестный суффикс
        "10mm",  # двойной суффикс
        "10 m",  # пробел внутри
        " 10m",  # ведущий пробел
        "10m ",  # хвостовой пробел
        "-5m",  # минус
        "10.5m",  # дробь
        "1y",  # неподдерживаемая единица (год)
        "1w",  # неподдерживаемая единица (неделя)
        "m10",  # суффикс перед числом
        "10M",  # верхний регистр не поддержан
        "10m\n",  # хвостовой перевод строки (\\Z, не $)
    ],
)
def test_garbage_raises(raw: str) -> None:
    # внимание: "10" из списка-донора отфильтровываем — это валидный numeric-вход
    if raw == "10":
        assert parse_since(raw) == 10
        return
    with pytest.raises(DurationParseError):
        parse_since(raw)


def test_error_is_value_error_subclass() -> None:
    # DurationParseError наследует ValueError — caller может ловить ValueError
    assert issubclass(DurationParseError, ValueError)
    with pytest.raises(ValueError):
        parse_since("garbage")


def test_error_message_contains_input_and_hint() -> None:
    # сообщение должно содержать сам мусорный вход (repr) и подсказку про формат
    with pytest.raises(DurationParseError) as exc:
        parse_since("nope")
    msg = str(exc.value)
    assert "'nope'" in msg
    assert "unix-ts" in msg
