"""Общее для ИУ-команд (`mpu iu-wb make-sql` / `fix-formulas`): чтение входа `[{nm_id, perc}]`.

Вход — JSON-массив объектов через stdin или последним позиционным аргументом.
"""

from __future__ import annotations

import json
import sys
from typing import Any, cast

import typer


def read_iu_input(payload: str | None, *, command_name: str) -> list[tuple[int, float]]:
    """Прочитать ИУ-вход `[{nm_id, perc}]` из `payload` (если задан) или из stdin.

    Возвращает список `(nm_id, perc)`, где perc — проценты (например 34.72).
    На любой ошибке — печать в stderr и `typer.Exit(2)`.
    """
    raw = payload if payload is not None else sys.stdin.read()
    if not raw.strip():
        typer.echo(
            f"{command_name}: пустой вход "
            f"(ожидался JSON [{{nm_id, perc}}] через stdin или последним аргументом)",
            err=True,
        )
        raise typer.Exit(2)
    try:
        loaded: Any = json.loads(raw)
    except json.JSONDecodeError as e:
        typer.echo(f"{command_name}: невалидный JSON: {e}", err=True)
        raise typer.Exit(2) from e
    if not isinstance(loaded, list) or not loaded:
        typer.echo(f"{command_name}: ожидался непустой JSON-массив объектов", err=True)
        raise typer.Exit(2)
    rows: list[tuple[int, float]] = []
    for i, item in enumerate(cast("list[Any]", loaded)):
        try:
            nm_id = int(item["nm_id"])
            perc = float(item["perc"])
        except (KeyError, TypeError, ValueError) as e:
            typer.echo(
                f"{command_name}: элемент #{i} не вида {{nm_id:int, perc:number}}: {item!r}",
                err=True,
            )
            raise typer.Exit(2) from e
        rows.append((nm_id, perc))
    return rows
