"""Сборка отчёта «карточки, перемещённые сегодня» для `mpu telegram status`.

Чистые функции (без сети/БД/telethon): окно «сегодня» в МСК, маппинг колонка→эмодзи и
рендер нумерованного markdown-списка. Источники данных (локальный журнал `kaiten_card_moves`
и live-история Kaiten) собираются в команде и передаются сюда уже как `StatusEntry`.

«Сегодня» = календарный день в МСК (UTC+3) — конвенция монорепо (`lib/backup_sql`, `commands/sun`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import cast

from mpu.lib import env

MSK = timezone(timedelta(hours=3))

_DONE_EMOJI = "✅"
_DEFAULT_EMOJI = "🔹"
# подстрока названия колонки (casefold) → эмодзи; первое совпадение выигрывает. «Готово»
# (готовность) обрабатывается отдельно ТОЧНЫМ совпадением, чтобы «Готово к код-ревью» и т.п.
# получали эмодзи своего этапа, а не зелёную галочку.
_EMOJI_RULES: tuple[tuple[str, str], ...] = (
    ("ревью", "👀"),
    ("тест", "🧪"),
    ("разработ", "🛠️"),
    ("выгру", "🚀"),
    ("dev", "🚀"),
    ("prod", "🚀"),
    ("очеред", "📋"),
    ("оцен", "📊"),
    ("баг", "🐞"),
)


@dataclass(frozen=True, slots=True)
class StatusEntry:
    """Одна перемещённая сегодня карточка для отчёта (источник-агностично)."""

    card_id: int
    title: str | None
    url: str
    column: str
    moved_at: int


def _msk_now(now: datetime | None = None) -> datetime:
    return (now or datetime.now(MSK)).astimezone(MSK)


def today_epoch_window(now: datetime | None = None) -> tuple[int, int]:
    """[начало, конец] текущего МСК-дня в Unix-epoch (сек), инклюзивно — для `list_moves`."""
    base = _msk_now(now)
    start = datetime(base.year, base.month, base.day, 0, 0, 0, tzinfo=MSK)
    end = datetime(base.year, base.month, base.day, 23, 59, 59, tzinfo=MSK)
    return int(start.timestamp()), int(end.timestamp())


def today_iso_window(now: datetime | None = None) -> tuple[str, str]:
    """Границы МСК-дня в UTC ISO-8601 (`...Z`) — для Kaiten `updated_after`/`updated_before`."""
    base = _msk_now(now)
    start = datetime(base.year, base.month, base.day, 0, 0, 0, tzinfo=MSK).astimezone(UTC)
    end = datetime(base.year, base.month, base.day, 23, 59, 59, tzinfo=MSK).astimezone(UTC)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(fmt), end.strftime(fmt)


def today_label(now: datetime | None = None) -> str:
    """Заголовочная метка дня, напр. «2026-06-24 МСК»."""
    return f"{_msk_now(now).date().isoformat()} МСК"


def is_today_msk(changed_iso: str | None, now: datetime | None = None) -> bool:
    """True, если ISO-8601 момент `changed` приходится на текущий МСК-день."""
    if not changed_iso:
        return False
    try:
        moment = datetime.fromisoformat(changed_iso.replace("Z", "+00:00"))
    except ValueError:
        return False
    return moment.astimezone(MSK).date() == _msk_now(now).date()


def iso_to_epoch(changed_iso: str | None) -> int:
    """ISO-8601 (`...Z`) → Unix-epoch (сек); пусто/мусор → 0."""
    if not changed_iso:
        return 0
    try:
        return int(datetime.fromisoformat(changed_iso.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def load_emoji_overrides() -> dict[str, str]:
    """Переопределения колонка→эмодзи из .env `KITEN_STATUS_EMOJI` (JSON; ключ — имя колонки).

    Пусто/невалидный JSON/не объект → `{}` (дефолтная карта). Ключи casefold."""
    raw = env.get("KITEN_STATUS_EMOJI")
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    data_dict = cast("dict[str, object]", data)
    return {str(k).casefold(): str(v) for k, v in data_dict.items()}


def emoji_for(column: str, overrides: dict[str, str] | None = None) -> str:
    """Эмодзи статуса по названию колонки: override → точное «Готово» (✅) → правила → дефолт."""
    key = column.casefold()
    if overrides and key in overrides:
        return overrides[key]
    if key == "готово":
        return _DONE_EMOJI
    for sub, emo in _EMOJI_RULES:
        if sub in key:
            return emo
    return _DEFAULT_EMOJI


def _md_escape(text: str) -> str:
    """Экранировать `[` / `]` в тексте ссылки (полноширинными), чтобы не ломать markdown."""
    return text.replace("[", "［").replace("]", "］")


def build_status_text(
    entries: list[StatusEntry],
    *,
    label: str,
    emoji_overrides: dict[str, str] | None = None,
) -> str:
    """Нумерованный markdown-список перемещённых сегодня карточек (новые сверху).

    Дедуп по `card_id` — остаётся запись с наибольшим `moved_at`. Формат строки:
    `N. [Title](url) — Колонка эмодзи`. Пустой список → строка «перемещений не было»."""
    latest: dict[int, StatusEntry] = {}
    for entry in entries:
        current = latest.get(entry.card_id)
        if current is None or entry.moved_at > current.moved_at:
            latest[entry.card_id] = entry
    items = sorted(latest.values(), key=lambda e: (e.moved_at, e.card_id), reverse=True)
    header = f"Карточки, перемещённые сегодня ({label}):"
    if not items:
        return f"{header}\n\nСегодня перемещений не было."
    lines = [header, ""]
    for n, entry in enumerate(items, start=1):
        title = _md_escape(entry.title) if entry.title else f"#{entry.card_id}"
        emo = emoji_for(entry.column, emoji_overrides)
        lines.append(f"{n}. [{title}]({entry.url}) — {entry.column} {emo}")
    return "\n".join(lines)
