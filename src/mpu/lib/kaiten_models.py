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
    id: int
    title: EmptyStr = ""
    state: int | None = None
    condition: int | None = None
    due_date: str | None = None
    updated: str | None = None
    board_id: int | None = None
    column_id: int | None = None
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


class KaitenMember(_ApiModel):
    id: int
    full_name: EmptyStr = ""
    email: EmptyStr = ""
    username: EmptyStr = ""


class KaitenComment(_ApiModel):
    id: int
    text: EmptyStr = ""  # GFM markdown
    author_name: str = ""
    created: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _author_name_from_nested(cls, raw: object) -> object:
        if is_dict(raw) and "author_name" not in raw:
            out = dict(raw)
            out["author_name"] = _member_name(raw.get("author"))
            return out
        return raw


class KaitenCustomProperty(_ApiModel):
    id: int
    name: EmptyStr = ""
    type: str | None = None


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
    out["tags"] = [str(t.get("name") or "") for t in dict_items(raw.get("tags"))]
    out["members"] = dict_items(raw.get("members"))
    out["files"] = dict_items(raw.get("files"))
    out["properties"] = _string_properties(raw.get("properties"))
    return out


# ── Парсеры (публичные имена сохранены; реэкспорт — lib/kaiten.py) ──────────────


def parse_user(raw: object) -> KaitenUser:
    """JSON GET /users/current → KaitenUser."""
    return KaitenUser.model_validate(raw)


def parse_card(raw: object, base_url: str) -> KaitenCard:
    """JSON-карточка из API → KaitenCard. Недостающие поля → None/пусто."""
    card = KaitenCard.model_validate(raw)
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


def parse_location_change(raw: object) -> KaitenLocationChange:
    """JSON-запись истории перемещений (GET /cards/{id}/location-history) → KaitenLocationChange."""
    return KaitenLocationChange.model_validate(raw)


def parse_card_detail(raw: object, base_url: str) -> KaitenCardDetail:
    """Полный JSON карточки (GET /cards/{id}) → KaitenCardDetail. Недостающее → None/[]."""
    wire = _flatten_card_detail_wire(raw) if is_dict(raw) else raw
    detail = KaitenCardDetail.model_validate(wire)
    return detail.model_copy(update={"url": card_url(base_url, detail.id)})
