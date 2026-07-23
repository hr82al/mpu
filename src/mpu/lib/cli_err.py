"""Единый форматтер машинно-читаемых CLI-ошибок (CLAUDE.md §1).

Формат: `<команда>: <причина>[; попробуй: <подсказка>]` в stderr + выход с кодом.
Команды не переизобретают локальные `_fail` — оборачивают эти функции, фиксируя
своё имя команды (см. `commands/_wb_loader.py`, `commands/ss_access.py`).
"""

from typing import NoReturn, Protocol

import click


def fail(
    command: str, reason: str, *, code: int, hint: str | None = None, extra: str | None = None
) -> NoReturn:
    """Машинно-читаемая ошибка `<команда>: <причина>; попробуй: <подсказка>` → exit."""
    msg = f"{command}: {reason}"
    if hint:
        msg += f"; попробуй: {hint}"
    click.echo(msg, err=True)
    if extra:
        click.echo(extra, err=True)
    raise SystemExit(code)


def die(message: str, *, code: int = 1) -> NoReturn:
    """Уже отформатированное сообщение (с префиксом команды) → stderr + exit."""
    click.echo(message, err=True)
    raise SystemExit(code)


class Fail(Protocol):
    """`fail` с уже зафиксированным именем команды."""

    def __call__(
        self, reason: str, *, code: int = 1, hint: str | None = None, extra: str | None = None
    ) -> NoReturn: ...


def bind(command: str) -> Fail:
    """Привязать имя команды к `fail` — вместо локальной обёртки `_fail` в каждом модуле.

    Модулю остаётся `_fail = bind(COMMAND)`, а call-site пишет `_fail("причина", code=2)`.
    """

    def _fail(
        reason: str, *, code: int = 1, hint: str | None = None, extra: str | None = None
    ) -> NoReturn:
        fail(command, reason, code=code, hint=hint, extra=extra)

    return _fail
