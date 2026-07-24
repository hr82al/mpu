"""Типобезопасный доступ к сырому JSON (`object`) — общие type-guard'ы границ.

Обобщение идиомы, впервые появившейся в `commands/_wb_loader.py` (CLAUDE.md §5:
«pydantic модель ИЛИ явный type-guard»). Используется wire-models модулями
(`lib/*_models.py`) и клиентами для сужения `Any`-ответов без `cast`.
Только stdlib — импортируется жадно без стартап-налога.
"""

from typing import TypeGuard


def is_dict(o: object) -> TypeGuard[dict[object, object]]:
    return isinstance(o, dict)


def is_list(o: object) -> TypeGuard[list[object]]:
    return isinstance(o, list)


def dict_items(raw_value: object) -> list[dict[object, object]]:
    """Значение API → список dict-элементов (не список / не-dict элементы отбрасываются)."""
    if not is_list(raw_value):
        return []
    return [entry for entry in raw_value if is_dict(entry)]
