"""Pydantic-модель workspace из 10X `/workspaces` — типизированная граница поверх
сырого `data[]` (ответ API и его sqlite-кэш `x10_email_clients.workspaces_json`).

Модуль импортируется ЛЕНИВО (паттерн lib/loki_models.py, см. CLAUDE.md «Стек»):
pydantic ~150 мс импорта, top-level импорт из commands/ запрещён.
"""

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mpu.lib.jsonx import dict_items


class Workspace(BaseModel):
    """Один workspace 10X. `owner_id` — строкой: сравнивается со `str(user_id)`."""

    model_config = ConfigDict(coerce_numbers_to_str=True, populate_by_name=True)

    id: int | None = None
    owner_id: str = Field(default="", alias="ownerId")
    name: str | None = None
    marketplace: str | None = None


def parse_workspaces(raw: object) -> list[Workspace]:
    """Сырой `data[]` → модели. Не-list / не-dict / невалидные элементы — пропуск."""
    out: list[Workspace] = []
    for entry in dict_items(raw):
        try:
            out.append(Workspace.model_validate(entry))
        except ValidationError:
            continue
    return out
