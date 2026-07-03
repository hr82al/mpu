"""Единый принтер структурного CLI-вывода (CLAUDE.md §1-2: дефолт — JSON для AI/pipe).

Один формат во всех командах: ensure_ascii=False (кириллица как есть), indent=2.
"""

import json

import click


def print_json(value: object) -> None:
    """Напечатать значение как pretty-JSON в stdout (unicode как есть, отступ 2)."""
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))
