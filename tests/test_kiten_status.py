"""Тесты `lib/kiten_status` — чистая сборка отчёта «перемещено сегодня» (без сети/БД)."""

from datetime import datetime

import pytest

from mpu.lib import kiten_status
from mpu.lib.kiten_status import MSK, StatusEntry, build_status_text


def _entry(card_id: int, *, title: str | None, column: str, moved_at: int) -> StatusEntry:
    return StatusEntry(
        card_id=card_id,
        title=title,
        url=f"https://btlz.kaiten.ru/{card_id}",
        column=column,
        moved_at=moved_at,
    )


# ── окна «сегодня» (МСК) ────────────────────────────────────────────────────────


def test_today_epoch_window_is_full_day() -> None:
    now = datetime(2026, 6, 24, 12, 0, 0, tzinfo=MSK)
    start, end = kiten_status.today_epoch_window(now)
    assert end - start == 86399
    # полдень текущего дня попадает в окно, тот же момент вчера — нет.
    noon = int(datetime(2026, 6, 24, 12, 0, 0, tzinfo=MSK).timestamp())
    yday = int(datetime(2026, 6, 23, 23, 30, 0, tzinfo=MSK).timestamp())
    assert start <= noon <= end
    assert not (start <= yday <= end)


def test_today_iso_window_utc_z() -> None:
    now = datetime(2026, 6, 24, 12, 0, 0, tzinfo=MSK)
    iso_from, iso_to = kiten_status.today_iso_window(now)
    # МСК-полночь = 21:00 UTC предыдущих суток.
    assert iso_from == "2026-06-23T21:00:00Z"
    assert iso_to == "2026-06-24T20:59:59Z"


def test_is_today_msk() -> None:
    now = datetime(2026, 6, 24, 12, 0, 0, tzinfo=MSK)
    assert kiten_status.is_today_msk("2026-06-24T08:00:00.000Z", now)  # 11:00 МСК — сегодня
    assert not kiten_status.is_today_msk("2026-06-23T08:00:00.000Z", now)
    assert not kiten_status.is_today_msk(None, now)
    assert not kiten_status.is_today_msk("мусор", now)


def test_iso_to_epoch() -> None:
    assert kiten_status.iso_to_epoch("1970-01-01T00:00:00Z") == 0
    assert kiten_status.iso_to_epoch(None) == 0
    assert kiten_status.iso_to_epoch("плохо") == 0
    assert kiten_status.iso_to_epoch("2026-06-24T00:00:00Z") > 0


# ── emoji_for ───────────────────────────────────────────────────────────────────


def test_emoji_done_exact_only() -> None:
    assert kiten_status.emoji_for("Готово") == "✅"
    # «Выполнено» — тоже done-колонка → зелёная галочка.
    assert kiten_status.emoji_for("Выполнено") == "✅"
    # «Готово к код-ревью» — НЕ done: получает эмодзи своего этапа (ревью), не галочку.
    assert kiten_status.emoji_for("Готово к код-ревью") == "👀"


def test_emoji_default_and_override() -> None:
    assert kiten_status.emoji_for("Нечто непонятное") == "🔹"
    assert kiten_status.emoji_for("Очередь", {"очередь": "🅾️"}) == "🅾️"


# ── load_column_map (из .env KITEN_COLUMN_MAP, ключ — имя колонки) ─────────────────


def test_load_column_map_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_status.env, "_loaded", True)
    monkeypatch.setenv("KITEN_COLUMN_MAP", '{"Тут только выполненные карточки!": "Выполнено"}')
    assert kiten_status.load_column_map() == {"тут только выполненные карточки!": "Выполнено"}


def test_load_column_map_empty_and_bad(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_status.env, "_loaded", True)
    monkeypatch.delenv("KITEN_COLUMN_MAP", raising=False)
    assert kiten_status.load_column_map() == {}
    monkeypatch.setenv("KITEN_COLUMN_MAP", "не json")
    assert kiten_status.load_column_map() == {}


# ── build_status_text ───────────────────────────────────────────────────────────


def test_build_status_empty() -> None:
    text = build_status_text([], label="2026-06-24 МСК")
    assert "Сегодня перемещений не было." in text


def test_build_status_numbered_links_and_emoji() -> None:
    entries = [
        _entry(100, title="Карточка A", column="Готово", moved_at=20),
        _entry(200, title="Карточка B", column="Код-ревью", moved_at=10),
    ]
    text = build_status_text(entries, label="2026-06-24 МСК")
    lines = text.splitlines()
    # новые сверху: 100 (moved_at=20) первым.
    assert lines[2] == "1. [Карточка A](https://btlz.kaiten.ru/100) — Готово ✅"
    assert lines[3] == "2. [Карточка B](https://btlz.kaiten.ru/200) — Код-ревью 👀"


def test_build_status_dedup_latest_wins() -> None:
    # одна карточка двигалась дважды сегодня → последняя колонка, одна строка.
    entries = [
        _entry(100, title="A", column="Код-ревью", moved_at=10),
        _entry(100, title="A", column="Готово", moved_at=50),
    ]
    text = build_status_text(entries, label="L")
    assert text.count("https://btlz.kaiten.ru/100") == 1
    assert "Готово ✅" in text
    assert "Код-ревью" not in text


def test_build_status_column_override_renames_and_checkmarks() -> None:
    # длинное имя done-колонки заменяется по KITEN_COLUMN_MAP → «Выполнено» + ✅.
    entries = [_entry(100, title="A", column="Тут только выполненные карточки!", moved_at=20)]
    overrides = {"тут только выполненные карточки!": "Выполнено"}
    text = build_status_text(entries, label="L", column_overrides=overrides)
    assert "— Выполнено ✅" in text
    assert "Тут только выполненные карточки!" not in text


def test_build_status_missing_title_fallback_and_escape() -> None:
    entries = [
        _entry(300, title=None, column="Очередь", moved_at=5),
        _entry(400, title="A [draft]", column="Очередь", moved_at=4),
    ]
    text = build_status_text(entries, label="L")
    assert "[#300](https://btlz.kaiten.ru/300)" in text
    # квадратные скобки в заголовке экранированы полноширинными.
    assert "［draft］" in text
    assert "[draft]" not in text


# ── today_label ─────────────────────────────────────────────────────────────────


def test_today_label() -> None:
    now = datetime(2026, 6, 24, 1, 0, 0, tzinfo=MSK)
    assert kiten_status.today_label(now) == "2026-06-24 МСК"


# ── load_emoji_overrides (из .env KITEN_STATUS_EMOJI, ключ — имя колонки) ─────────


def test_load_emoji_overrides_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_status.env, "_loaded", True)
    monkeypatch.setenv("KITEN_STATUS_EMOJI", '{"Очередь": "🅾️"}')
    assert kiten_status.load_emoji_overrides() == {"очередь": "🅾️"}


def test_load_emoji_overrides_empty_bad_and_nonobject(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_status.env, "_loaded", True)
    monkeypatch.delenv("KITEN_STATUS_EMOJI", raising=False)
    assert kiten_status.load_emoji_overrides() == {}
    monkeypatch.setenv("KITEN_STATUS_EMOJI", "не json")
    assert kiten_status.load_emoji_overrides() == {}
    # валидный JSON, но не объект (массив) → {} (дефолтная карта).
    monkeypatch.setenv("KITEN_STATUS_EMOJI", '["x"]')
    assert kiten_status.load_emoji_overrides() == {}


# ── load_column_map: валидный JSON, но не объект ─────────────────────────────────


def test_load_column_map_nonobject(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_status.env, "_loaded", True)
    monkeypatch.setenv("KITEN_COLUMN_MAP", "[1, 2]")
    assert kiten_status.load_column_map() == {}


# ── build_status_text: дедуп оставляет запись с бОльшим moved_at ──────────────────


def test_build_status_dedup_keeps_earlier_when_later_is_smaller() -> None:
    # первый apply бОльший moved_at, второй для той же карточки меньший → остаётся первый.
    entries = [
        _entry(100, title="A", column="Готово", moved_at=50),
        _entry(100, title="A", column="Код-ревью", moved_at=10),
    ]
    text = build_status_text(entries, label="L")
    assert text.count("https://btlz.kaiten.ru/100") == 1
    assert "Готово ✅" in text
    assert "Код-ревью" not in text
