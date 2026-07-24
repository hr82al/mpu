"""Pydantic-модели Kaiten API + парсеры — типизированная граница `lib/kaiten.py`.

Модуль импортируется ЛЕНИВО (паттерн lib/loki_models.py, см. CLAUDE.md «Стек»):
pydantic ~150 мс импорта, top-level импорт из commands/ и жадно грузящихся lib
запрещён. `lib/kaiten.py` реэкспортирует эти имена через модульный `__getattr__`.

Терпимость ручных парсеров сохранена: отсутствующее/falsy строковое поле → "",
мусорные элементы списков (`members`/`files`/`tags`/`boards`) отбрасываются
поштучно, не-dict вложенные объекты (`owner`/`author`) → None/пусто.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from mpu.lib.jsonx import dict_items, is_dict
from mpu.lib.kaiten import card_url

# ── Общие примитивы терпимого декода ────────────────────────────────────────────


def _falsy_to_empty(v: object) -> object:
    """`str(raw.get(x) or "")` ручных парсеров: None/0/False/"" → ""."""
    return v if v else ""


# Числа стрингифицируются конфигом модели (coerce_numbers_to_str), falsy → "".
EmptyStr = Annotated[str, BeforeValidator(_falsy_to_empty)]
# `bool(raw.get(x))` ручных парсеров: любое truthy → True.
TruthyBool = Annotated[bool, BeforeValidator(bool)]


def _date_only(v: object) -> object:
    """Календарный день из wire-значения `for_date`: срез первых 10 символов.

    Kaiten отдаёт это поле двумя формами — `2026-07-20` (GET списка) и
    `2026-07-20T00:00:00.000Z` (ответ POST/PATCH). Это ЯРЛЫК ДНЯ, а не момент времени:
    парсить его как инстант и конвертировать в локальную зону нельзя — в UTC-5 полночь
    20-го станет 19-м, то есть тихий сдвиг записи на день назад.
    """
    return str(v)[:10] if v else ""


# Дата-ярлык `YYYY-MM-DD`, нормализованная из обеих wire-форм (см. `_date_only`).
DateOnly = Annotated[str, BeforeValidator(_date_only)]


def _member_name(raw: object) -> str:
    """full_name автора из вложенного `author`/`owner` объекта; пусто, если нет."""
    if not is_dict(raw):
        return ""
    return str(raw.get("full_name") or raw.get("username") or "")


def _nested_title(raw: dict[object, object], key: str) -> str | None:
    """`title` вложенного объекта (`board`/`column`/`lane`/`type`); None, если нет."""
    obj = raw.get(key)
    if is_dict(obj):
        title = obj.get("title")
        return str(title) if title is not None else None
    return None


def _nested_label(raw: dict[object, object], key: str) -> str | None:
    """Человекочитаемое имя вложенного объекта; None, если нет.

    У `board`/`column`/`lane` оно лежит в `title`, у `type` — в `name`, поэтому берём
    первое непустое из двух.
    """
    obj = raw.get(key)
    if is_dict(obj):
        label = obj.get("title") or obj.get("name")
        return str(label) if label else None
    return None


def _string_properties(props: object) -> dict[str, str]:
    """`properties` карточки → только строковые значения (ключи id_NNN). Не-строки
    (select/catalog → id/массив) приводим к str, чтобы не терять поле."""
    if not is_dict(props):
        return {}
    out: dict[str, str] = {}
    for key, value in props.items():
        if value is None:
            continue
        out[str(key)] = value if isinstance(value, str) else str(value)
    return out


class _ApiModel(BaseModel):
    """База wire-моделей: числа в строковых полях стрингифицируются (как str(x) раньше)."""

    model_config = ConfigDict(coerce_numbers_to_str=True)


# ── Модели ──────────────────────────────────────────────────────────────────────


class KaitenUser(_ApiModel):
    id: int
    full_name: EmptyStr = ""
    username: EmptyStr = ""
    email: EmptyStr = ""


class KaitenCard(_ApiModel):
    """Карточка из списочного ответа GET /cards.

    Поля ниже `column_id` добавлены для `mpu kiten status` и все опциональны: карточка
    приходит и из усечённых источников (вложенный `card` записи учёта времени / события
    активности), где вложенных объектов места нет — там остаётся только `*_id`.
    """

    id: int
    title: EmptyStr = ""
    state: int | None = None
    condition: int | None = None
    due_date: str | None = None
    updated: str | None = None
    board_id: int | None = None
    column_id: int | None = None
    lane_id: int | None = None
    archived: TruthyBool = False
    last_moved_at: str | None = None
    time_spent_sum: int | None = None  # суммарно по карточке ВСЕМИ участниками, МИНУТЫ
    board_title: str | None = None
    space_title: str | None = None
    column_title: str | None = None
    lane_title: str | None = None
    type_name: str | None = None
    url: str = ""  # web-URL; не из wire — подставляет parse_card


class KaitenSpace(_ApiModel):
    id: int
    title: EmptyStr = ""
    archived: TruthyBool = False


class KaitenBoard(_ApiModel):
    id: int
    space_id: int
    title: EmptyStr = ""


class KaitenLane(_ApiModel):
    id: int
    board_id: int
    title: EmptyStr = ""


class KaitenColumn(_ApiModel):
    id: int
    board_id: int
    title: EmptyStr = ""
    sort_order: float | None = None  # порядок колонки на доске (слева→направо); для релог-bump


class KaitenFile(_ApiModel):
    id: int
    url: EmptyStr = ""
    name: EmptyStr = ""
    mime_type: str | None = None
    comment_id: int | None = None  # None = card-level, иначе вложение комментария
    card_cover: TruthyBool = False
    custom_property_id: int | None = None  # None = не в поле, иначе id файлового кастомного поля


class KaitenMember(_ApiModel):
    id: int
    full_name: EmptyStr = ""
    email: EmptyStr = ""
    username: EmptyStr = ""


class KaitenComment(_ApiModel):
    id: int
    text: EmptyStr = ""  # GFM markdown
    author_name: str = ""
    author_id: int | None = None  # нужен, чтобы отличить свой комментарий от чужого
    created: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _author_name_from_nested(cls, raw: object) -> object:
        if is_dict(raw) and "author_name" not in raw:
            out = dict(raw)
            out["author_name"] = _member_name(raw.get("author"))
            author = raw.get("author")
            if "author_id" not in raw and is_dict(author):
                out["author_id"] = author.get("id")
            return out
        return raw


class KaitenCustomProperty(_ApiModel):
    id: int
    name: EmptyStr = ""
    type: str | None = None


class KaitenRole(_ApiModel):
    """Роль пользователя = «тип работы» записи учёта времени (GET /user-roles)."""

    id: int
    name: EmptyStr = ""


class KaitenTimeLog(_ApiModel):
    """Запись учёта времени карточки (GET/POST /cards/{id}/time-logs).

    `time_spent` — МИНУТЫ (единица Kaiten). `for_date` — календарный день записи; wire отдаёт
    его двумя формами (`2026-07-20` из GET, `2026-07-20T00:00:00.000Z` из POST/PATCH), поэтому
    он режется до `YYYY-MM-DD` валидатором `DateOnly` — см. его док про запрет конвертации зон.

    ⚠️ Вложенные объекты `user`/`author` НЕ объявлены намеренно: в них сидит base64-PNG
    аватара (~4 КБ на запись), который иначе утёк бы в `--json`. Из них вытаскиваются
    только плоские строки `role_name`/`user_name` — новых полей-объектов сюда не добавлять.
    """

    id: int
    card_id: int
    user_id: int | None = None
    author_id: int | None = None
    role_id: int | None = None
    role_name: str | None = None
    user_name: str | None = None
    time_spent: int = 0
    for_date: DateOnly = ""
    comment: EmptyStr = ""  # очищенный комментарий приходит как null → ""

    @model_validator(mode="before")
    @classmethod
    def _names_from_nested(cls, raw: object) -> object:
        if not is_dict(raw):
            return raw
        out = dict(raw)
        if "role_name" not in raw:
            role = raw.get("role")
            out["role_name"] = str(role.get("name") or "") if is_dict(role) else None
        if "user_name" not in raw:
            out["user_name"] = _member_name(raw.get("user")) or None
        return out


class KaitenTimeLogEntry(KaitenTimeLog):
    """Запись учёта времени из окна пользователя (GET /users/{id}/time-logs?from=&to=).

    От `KaitenTimeLog` (записи одной карточки) отличается вложенной карточкой: именно она
    даёт карточки, где пользователь работал, НЕ будучи участником, без обхода всех досок.
    ⚠️ `user`/`author`-объекты по-прежнему не объявлены — см. предупреждение в базовом классе.
    """

    card: KaitenCard | None = None


class KaitenActivity(_ApiModel):
    """Событие ленты моих действий (GET /users/current/activities).

    `id` здесь строковый: он же курсор пагинации (`cursor_id`) вместе с `created`
    (`cursor_created`). Вложенные `board`/`column`/`lane` события намеренно не объявлены —
    они описывают место НА МОМЕНТ действия, а не текущее.
    """

    id: EmptyStr = ""
    created: str | None = None
    action: EmptyStr = ""
    card_id: int | None = None
    card: KaitenCard | None = None


class KaitenTimer(_ApiModel):
    """Таймер пользователя на карточке (GET /cards/{id} → `timer`, POST/PATCH /user-timers).

    Роли у таймера НЕТ: `role_id` при старте API принимает, но не сохраняет — тип работы
    выбирается в момент остановки. `card_time_log_id` заполняется только после остановки.
    """

    id: int
    card_id: int | None = None
    card_title: EmptyStr = ""
    comment: EmptyStr = ""
    started_at: str | None = None
    finished_at: str | None = None
    card_time_log_id: int | None = None


class KaitenLocationChange(_ApiModel):
    """Запись перемещения карточки (GET /cards/{id}/location-history): кто и когда сменил
    колонку/дорожку. `changed` — ISO-8601 UTC; `author_id` — кто двигал."""

    card_id: int
    column_id: int | None = None
    lane_id: int | None = None
    author_id: int | None = None
    author_name: str | None = None
    changed: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _author_name_from_nested(cls, raw: object) -> object:
        if is_dict(raw) and "author_name" not in raw:
            out = dict(raw)
            out["author_name"] = _member_name(raw.get("author")) or None
            return out
        return raw


class KaitenCardDetail(_ApiModel):
    id: int
    key: str | None = None
    title: EmptyStr = ""
    state: int | None = None
    condition: int | None = None
    due_date: str | None = None
    board_id: int | None = None
    board_title: str | None = None
    column_id: int | None = None
    column_title: str | None = None
    lane_title: str | None = None
    size_text: str | None = None
    created: str | None = None
    updated: str | None = None
    type_name: str | None = None
    description: str | None = None  # GFM markdown
    owner: KaitenMember | None = None
    time_spent_sum: int | None = None  # суммарно списано по карточке, МИНУТЫ
    timer: KaitenTimer | None = None  # запущенный таймер текущего пользователя; None — нет
    url: str = ""  # web-URL; не из wire — подставляет parse_card_detail
    tags: list[str] = Field(default_factory=list[str])
    members: list[KaitenMember] = Field(default_factory=list[KaitenMember])
    files: list[KaitenFile] = Field(default_factory=list[KaitenFile])
    properties: dict[str, str] = Field(default_factory=dict[str, str])


def _flatten_card_detail_wire(raw: dict[object, object]) -> dict[object, object]:
    """Wire-форма полной карточки → плоские поля модели.

    Только для JSON из API (`parse_card_detail`) — прямое конструирование модели
    (тесты, `model_copy`) идёт мимо и валидируется pydantic'ом как есть. Wire-семантика
    ручного парсера: `*_title` из вложенных объектов, не-dict `owner` → None, из
    `tags`/`members`/`files` отбрасываются не-dict элементы, `properties` стрингифицируются.
    """
    out = dict(raw)
    out["board_title"] = _nested_title(raw, "board")
    out["column_title"] = _nested_title(raw, "column")
    out["lane_title"] = _nested_title(raw, "lane")
    out["type_name"] = _nested_title(raw, "type")
    owner = raw.get("owner")
    out["owner"] = owner if is_dict(owner) else None
    timer = raw.get("timer")
    out["timer"] = timer if is_dict(timer) else None
    out["tags"] = [str(t.get("name") or "") for t in dict_items(raw.get("tags"))]
    out["members"] = dict_items(raw.get("members"))
    out["files"] = dict_items(raw.get("files"))
    out["properties"] = _string_properties(raw.get("properties"))
    return out


# ── Парсеры (публичные имена сохранены; реэкспорт — lib/kaiten.py) ──────────────


def parse_user(raw: object) -> KaitenUser:
    """JSON GET /users/current → KaitenUser."""
    return KaitenUser.model_validate(raw)


def _flatten_card_wire(raw: dict[object, object]) -> dict[object, object]:
    """Wire-форма списочной карточки → плоские `*_title` / `type_name`.

    Только для JSON из API: прямое конструирование модели (тесты, `model_copy`) идёт
    мимо. Ключ пишется лишь когда вложенный объект реально есть — иначе уже переданное
    плоское значение затиралось бы на None (карточка из записи учёта времени приходит
    без `column`/`lane`, и её место резолвится по справочнику).
    """
    out = dict(raw)
    for field, key in (
        ("board_title", "board"),
        ("column_title", "column"),
        ("lane_title", "lane"),
        ("type_name", "type"),
    ):
        label = _nested_label(raw, key)
        if label is not None:
            out[field] = label
    space = _board_space_title(raw)
    if space is not None:
        out["space_title"] = space
    return out


def _board_space_title(raw: dict[object, object]) -> str | None:
    """Пространство карточки: `board.spaces[].title` (плоского `space` в ответе нет).

    Нужно как осмысленная подпись места: у части досок дорожек нет вовсе, а имя самой
    доски бывает служебным («Не использовать для новых карточек!»).
    """
    board = raw.get("board")
    if not is_dict(board):
        return None
    for space in dict_items(board.get("spaces")):
        title = space.get("title")
        if title:
            return str(title)
    return None


def parse_card(raw: object, base_url: str) -> KaitenCard:
    """JSON-карточка из API → KaitenCard. Недостающие поля → None/пусто."""
    card = KaitenCard.model_validate(_flatten_card_wire(raw) if is_dict(raw) else raw)
    return card.model_copy(update={"url": card_url(base_url, card.id)})


def parse_space(raw: object) -> KaitenSpace:
    """JSON-space из GET /spaces → KaitenSpace. `boards[]` извлекается отдельно."""
    return KaitenSpace.model_validate(raw)


def parse_lane(raw: object) -> KaitenLane:
    """JSON-lane из GET /boards/{id}/lanes → KaitenLane."""
    return KaitenLane.model_validate(raw)


def parse_column(raw: object) -> KaitenColumn:
    """JSON-column из GET /boards/{id}/columns → KaitenColumn. `card.column_id` → column.id."""
    return KaitenColumn.model_validate(raw)


def parse_boards_of_space(raw: object) -> list[KaitenBoard]:
    """Встроенный в space `boards[]` → list[KaitenBoard]. Нет ключа / не список → [].

    `space_id` доски может отсутствовать во вложенном виде — тогда берётся id самого space.
    """
    if not is_dict(raw):
        return []
    parsed: list[KaitenBoard] = []
    for entry in dict_items(raw.get("boards")):
        merged = dict(entry)
        if not merged.get("space_id"):
            merged["space_id"] = raw.get("id")
        parsed.append(KaitenBoard.model_validate(merged))
    return parsed


def parse_member(raw: object) -> KaitenMember:
    """JSON-участник (members[]/owner) → KaitenMember. Недостающие поля → пусто."""
    return KaitenMember.model_validate(raw)


def parse_file(raw: object) -> KaitenFile:
    """JSON-файл (files[]) → KaitenFile. `comment_id=null` ⇒ вложение карточки."""
    return KaitenFile.model_validate(raw)


def parse_comment(raw: object) -> KaitenComment:
    """JSON-комментарий (GET /cards/{id}/comments) → KaitenComment. `text` — GFM markdown."""
    return KaitenComment.model_validate(raw)


def parse_custom_property(raw: object) -> KaitenCustomProperty:
    """JSON-определение кастомного поля (GET /company/custom-properties) → KaitenCustomProperty."""
    return KaitenCustomProperty.model_validate(raw)


def parse_role(raw: object) -> KaitenRole:
    """JSON-роль (GET /user-roles) → KaitenRole. Роль = «тип работы» в учёте времени."""
    return KaitenRole.model_validate(raw)


def parse_time_log(raw: object) -> KaitenTimeLog:
    """JSON-запись учёта времени (GET/POST /cards/{id}/time-logs) → KaitenTimeLog."""
    return KaitenTimeLog.model_validate(raw)


def parse_time_log_entry(raw: object, base_url: str) -> KaitenTimeLogEntry:
    """JSON-запись из GET /users/{id}/time-logs (окно from/to) → KaitenTimeLogEntry."""
    if not is_dict(raw):
        return KaitenTimeLogEntry.model_validate(raw)
    out = dict(raw)
    card = raw.get("card")
    out["card"] = parse_card(card, base_url) if is_dict(card) else None
    return KaitenTimeLogEntry.model_validate(out)


def parse_activity(raw: object, base_url: str) -> KaitenActivity:
    """JSON-событие из GET /users/current/activities → KaitenActivity."""
    if not is_dict(raw):
        return KaitenActivity.model_validate(raw)
    out = dict(raw)
    card = raw.get("card")
    out["card"] = parse_card(card, base_url) if is_dict(card) else None
    return KaitenActivity.model_validate(out)


def parse_timer(raw: object) -> KaitenTimer:
    """JSON-таймер (POST/PATCH /user-timers) → KaitenTimer."""
    return KaitenTimer.model_validate(raw)


def parse_location_change(raw: object) -> KaitenLocationChange:
    """JSON-запись истории перемещений (GET /cards/{id}/location-history) → KaitenLocationChange."""
    return KaitenLocationChange.model_validate(raw)


def parse_card_detail(raw: object, base_url: str) -> KaitenCardDetail:
    """Полный JSON карточки (GET /cards/{id}) → KaitenCardDetail. Недостающее → None/[]."""
    wire = _flatten_card_detail_wire(raw) if is_dict(raw) else raw
    detail = KaitenCardDetail.model_validate(wire)
    return detail.model_copy(update={"url": card_url(base_url, detail.id)})
