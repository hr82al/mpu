"""`mpu kiten status` — слой данных: этапы, строки выдачи, сбор источников, фильтры.

Здесь нет ни печати, ни ширины терминала (это `_status_render.py`) и ни одной опции CLI
(это `status.py`). Сеть — только в `collect`, всё остальное чистое и тестируется без неё.
"""

from __future__ import annotations

import json as _json
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import typer

from mpu.commands.kiten._common import COMMAND_NAME
from mpu.lib import env, kaiten_cache
from mpu.lib.kaiten import KaitenAPIError, KaitenClient

if TYPE_CHECKING:
    # Только аннотации: runtime-импорт моделей тянет pydantic (~150 мс) в startup.
    from mpu.lib.kaiten_models import KaitenActivity, KaitenCard, KaitenTimeLogEntry

# Числовые константы Kaiten (в самом API это безымянные коды).
STATE_DONE = 3
CONDITION_ACTIVE = 1
CONDITION_ARCHIVED = 2

# ── Этапы ───────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Stage:
    """Канонический этап: подпись в трёх ширинах + подстроки названий колонок Kaiten."""

    label: str
    short: str
    letter: str
    keys: tuple[str, ...]


# Порядок = конвейер слева направо. Сопоставление идёт в ОБРАТНОМ порядке (см. `stage_of`).
STAGES: tuple[Stage, ...] = (
    Stage("Очередь", "Оче", "О", ("очеред", "бэклог", "backlog", "назначенн")),
    Stage("Оценка", "Оцн", "Ц", ("оцен",)),
    Stage("В работе", "Раб", "Р", ("в работе", "разработ", "баги", "эскалац")),
    Stage("Ревью", "Рев", "В", ("ревью", "согласовани")),
    Stage("Тест", "Тст", "Т", ("тестирован", "тест")),
    Stage("DEV", "DEV", "D", ("dev", "выгрузк", "выгружен")),
    Stage("Пред-прод", "Ппр", "P", ("pred-prod", "предпрод", "фг")),
    Stage("Готово", "Гтв", "Г", ("готово", "выполненные")),
)
DONE_STAGE = STAGES[-1]
UNKNOWN_STAGE = "—"
ESCALATION_KEY = "эскалац"

# Латинские алиасы для `--stage` (кириллицу в терминале набирать неудобно).
STAGE_ALIASES = {
    "queue": "Очередь",
    "estimate": "Оценка",
    "work": "В работе",
    "review": "Ревью",
    "test": "Тест",
    "dev": "DEV",
    "preprod": "Пред-прод",
    "done": "Готово",
}


def load_stage_overrides() -> dict[str, str]:
    """`.env` KITEN_STAGE_MAP: JSON `имя колонки → этап`, поверх правил по умолчанию.

    Пусто/некорректный JSON → `{}` с предупреждением в stderr (как `_load_column_map`).
    Ключи сравниваются без учёта регистра.
    """
    raw = env.get("KITEN_STAGE_MAP")
    if not raw or not raw.strip():
        return {}
    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as e:
        typer.echo(f"{COMMAND_NAME} status: некорректный JSON в KITEN_STAGE_MAP: {e}", err=True)
        return {}
    if not isinstance(data, dict):
        typer.echo(f"{COMMAND_NAME} status: KITEN_STAGE_MAP должен быть JSON-объектом", err=True)
        return {}
    items: dict[str, object] = data  # pyright: ignore[reportUnknownVariableType]
    return {str(k).casefold(): str(v) for k, v in items.items()}


def stage_of(column_title: str | None, overrides: dict[str, str] | None = None) -> str:
    """Название колонки Kaiten → канонический этап; `—`, если не опознано.

    Сопоставление идёт по конвейеру С КОНЦА: «Готово к тестированию QA» — это гейт
    ТЕСТА, а не «Готово», и побеждать должно самое позднее совпадение. По той же причине
    «Готово к выгрузке на pred-prod» — «Пред-прод», а не «DEV» (обе подстроки есть).
    """
    title = (column_title or "").strip()
    if not title:
        return UNKNOWN_STAGE
    low = title.casefold()
    if overrides and low in overrides:
        return overrides[low]
    for stage in reversed(STAGES):
        if stage is DONE_STAGE:
            continue  # общее «готово» проверяем последним — иначе съест все гейты
        if any(key in low for key in stage.keys):
            return stage.label
    if any(key in low for key in DONE_STAGE.keys):
        return DONE_STAGE.label
    return UNKNOWN_STAGE


def is_escalated(column_title: str | None) -> bool:
    """Колонка «Эскалация» — не шаг конвейера, а признак срочности (флаг у строки)."""
    return ESCALATION_KEY in (column_title or "").casefold()


def resolve_stage_filter(value: str) -> str | None:
    """`--stage`: латинский алиас, точное имя или подстрока этапа → канонический этап."""
    needle = value.strip().casefold()
    if needle in STAGE_ALIASES:
        return STAGE_ALIASES[needle]
    for stage in STAGES:
        if needle == stage.label.casefold() or needle in stage.label.casefold():
            return stage.label
    return None


# ── Строки выдачи ───────────────────────────────────────────────────────────────

SRC_ASSIGNED = "assigned"
SRC_TIME = "time"
SRC_ACTIVITY = "activity"
# Все три глифа — РОВНО 2 терминальные ячейки (проверено `rich.cells.cell_len`), поэтому
# колонка не разъезжается. Популярный «⏱» занимает 1 ячейку — брать его сюда нельзя.
SRC_MARKS: tuple[tuple[str, str], ...] = (
    (SRC_ASSIGNED, "👤"),
    (SRC_TIME, "🕒"),
    (SRC_ACTIVITY, "📝"),
)
SRC_LEGEND = "👤 назначена · 🕒 списывал время · 📝 комментировал/двигал"


@dataclass
class StatusRow:
    """Карточка в выдаче: место, этап, мои минуты и почему она здесь."""

    card: KaitenCard
    stage: str
    sources: set[str] = field(default_factory=set[str])
    my_minutes: int = 0
    escalated: bool = False

    @property
    def closed(self) -> bool:
        """Завершена: `state=done` или уехала в архив."""
        return self.card.state == STATE_DONE or self.card.condition == CONDITION_ARCHIVED


def source_marks(sources: Iterable[str]) -> str:
    """Три фиксированные позиции по 2 ячейки: есть источник → глиф, нет → два пробела."""
    present = set(sources)
    return "".join(mark if key in present else "  " for key, mark in SRC_MARKS)


def pick_card(current: KaitenCard | None, candidate: KaitenCard) -> KaitenCard:
    """Какую версию карточки оставить, если она пришла из нескольких источников.

    Побеждает та, у которой есть название колонки: `/cards` отдаёт место вложенными
    объектами, а карточка внутри записи учёта времени — только `column_id`. При равенстве
    остаётся уже собранная (первый источник в порядке сбора — самый свежий).
    """
    if current is None:
        return candidate
    if current.column_title:
        return current
    return candidate if candidate.column_title else current


def in_scope(card: KaitenCard, since_day: str) -> bool:
    """Попадает ли карточка в выдачу: живая (не архив) ИЛИ обновлялась внутри окна.

    Годовое окно учёта времени нужно только для суммы минут — на попадание в таблицу оно
    не влияет, иначе в выдачу приехали бы все карточки года.
    """
    if card.condition == CONDITION_ACTIVE and not card.archived:
        return True
    return (card.updated or "")[:10] >= since_day


def sort_rows(rows: list[StatusRow]) -> list[StatusRow]:
    """Незакрытые сверху, внутри — по свежести `updated` (новые первыми)."""
    return sorted(rows, key=lambda r: (r.closed, _descending(r.card.updated or "")))


def _descending(value: str) -> tuple[int, ...]:
    """Ключ для сортировки строк ПО УБЫВАНИЮ внутри общего возрастающего sorted()."""
    return tuple(-ord(ch) for ch in value)


def present_stages(rows: Iterable[StatusRow]) -> list[Stage]:
    """Этапы, в которых реально есть карточки, в порядке конвейера (пустые не печатаем)."""
    used = {row.stage for row in rows}
    return [stage for stage in STAGES if stage.label in used]


def summarise_minutes(
    logs: Iterable[KaitenTimeLogEntry], since_day: str
) -> tuple[int, list[tuple[str, int]]]:
    """Итог за окно: всего минут и разбивка по типам работ (роль записи), больше — выше."""
    by_role: Counter[str] = Counter()
    for log in logs:
        if log.for_date >= since_day:
            by_role[log.role_name or UNKNOWN_STAGE] += log.time_spent
    return sum(by_role.values()), by_role.most_common()


# ── Фильтры выдачи ──────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class RowFilters:
    """Сужение выдачи флагами команды; пустой фильтр — тождественная операция."""

    stage: str | None = None
    board_id: int | None = None
    source: str | None = None
    only_open: bool = False
    only_done: bool = False


def apply_filters(rows: list[StatusRow], filters: RowFilters) -> list[StatusRow]:
    """Последовательно сузить строки по каждой заданной оси фильтра."""
    out = rows
    if filters.stage:
        out = [r for r in out if r.stage == filters.stage]
    if filters.board_id is not None:
        out = [r for r in out if r.card.board_id == filters.board_id]
    if filters.source:
        out = [r for r in out if filters.source in r.sources]
    if filters.only_open:
        out = [r for r in out if not r.closed]
    if filters.only_done:
        out = [r for r in out if r.closed]
    return out


# ── Сбор источников (единственное место с сетью) ────────────────────────────────


def iso_utc(ts: int) -> str:
    """Unix-ts → ISO-8601 UTC в форме, которую понимают фильтры Kaiten."""
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Collected:
    """Сырой результат сбора: строки + всё, что нужно подвалу и предупреждениям."""

    rows: list[StatusRow]
    logs: list[KaitenTimeLogEntry]
    activity_reach: str  # до какой даты реально дотянулась лента активностей


@dataclass(frozen=True, slots=True)
class Window:
    """Границы сбора: окно попадания в таблицу и окно суммирования моего времени."""

    since_day: str
    since_iso: str
    time_from_iso: str
    max_pages: int


def collect(client: KaitenClient, *, me_id: int, window: Window) -> Collected:
    """Собрать три источника «моего» в строки выдачи. Сеть — здесь и только здесь."""
    cards: dict[int, KaitenCard] = {}
    sources: dict[int, set[str]] = {}
    minutes: dict[int, int] = {}

    def add(card: KaitenCard | None, source: str) -> None:
        if card is None:
            return
        cards[card.id] = pick_card(cards.get(card.id), card)
        sources.setdefault(card.id, set()).add(source)

    for card in client.list_cards(member_ids=str(me_id), condition=CONDITION_ACTIVE):
        add(card, SRC_ASSIGNED)
    for card in client.list_cards(responsible_id=me_id, condition=CONDITION_ACTIVE):
        add(card, SRC_ASSIGNED)

    now_iso = iso_utc(int(datetime.now(tz=UTC).timestamp()))
    logs = client.list_user_time_logs(me_id, from_iso=window.time_from_iso, to_iso=now_iso)
    for log in logs:
        minutes[log.card_id] = minutes.get(log.card_id, 0) + log.time_spent
        if log.card is not None and log.for_date >= window.since_day:
            add(log.card, SRC_TIME)

    activities: list[KaitenActivity] = client.list_my_activities(
        since_iso=window.since_iso, max_pages=window.max_pages
    )
    for act in activities:
        if (act.created or "") >= window.since_iso:
            add(act.card, SRC_ACTIVITY)

    rows = [
        StatusRow(
            card=card,
            stage=UNKNOWN_STAGE,
            sources=sources[card_id],
            my_minutes=minutes.get(card_id, 0),
        )
        for card_id, card in cards.items()
        if in_scope(card, window.since_day)
    ]
    reach = min((a.created or "" for a in activities), default="")
    return Collected(rows=rows, logs=logs, activity_reach=reach)


def fill_stages(rows: list[StatusRow]) -> None:
    """Проставить этап и флаг эскалации, дорезолвив недостающие названия места.

    Карточки из учёта времени и ленты активностей приходят без вложенных объектов места
    (только `*_id`), поэтому колонка и доска добираются из локального справочника.
    """
    names = column_names(rows)
    boards = dict(kaiten_cache.cached_boards())
    overrides = load_stage_overrides()
    for row in rows:
        title = row.card.column_title or names.get(row.card.column_id or -1)
        patch = _place_patch(row, title, boards)
        if patch:
            row.card = row.card.model_copy(update=patch)
        row.stage = stage_of(title, overrides)
        row.escalated = is_escalated(title)


def _place_patch(row: StatusRow, title: str | None, boards: dict[int, str]) -> dict[str, str]:
    """Чего не хватает карточке из усечённого источника: имени колонки и/или доски."""
    patch: dict[str, str] = {}
    if title and not row.card.column_title:
        patch["column_title"] = title
    if not row.card.board_title:
        board = boards.get(row.card.board_id or -1)
        if board:
            patch["board_title"] = board
    return patch


def column_names(rows: Iterable[StatusRow]) -> dict[int, str]:
    """Названия колонок для карточек, пришедших БЕЗ вложенного `column`: сперва локальный
    кэш справочника, при промахе — догрузка досок, которых в нём не хватило."""
    names = dict(kaiten_cache.cached_columns())
    missing_boards = {
        row.card.board_id
        for row in rows
        if row.card.column_id is not None
        and row.card.column_id not in names
        and row.card.board_id is not None
    }
    if missing_boards:
        try:
            kaiten_cache.discover_columns_and_store(sorted(missing_boards))
            names = dict(kaiten_cache.cached_columns())
        except KaitenAPIError:
            pass  # без справочника этап будет «—», строку всё равно показываем
    return names
