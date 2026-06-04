"""`mpu kiten <ls|whoami>` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten ls`     — карточки, где я участник (member). Фильтры по умолчанию из
  `.env` (KITEN_LS_*), CLI-флаги переопределяют. `--json` — машинный вывод.
- `mpu kiten whoami` — мой id / имя / email по токену (GET /users/current).

ENV (~/.config/mpu/.env): KITEN_API_KEY, KITEN_BASE_URL, KITEN_LS_CONDITION,
KITEN_LS_STATES, KITEN_LS_SPACE_ID, KITEN_LS_BOARD_ID.

Стиль: фильтры сводятся декларативно через `coalesce(cli, env, default)`, таблица
описана data-driven спекой колонок `_COLUMNS` и рендерится через rich.
"""

from __future__ import annotations

import json as _json
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from mpu.lib.kaiten import KaitenAPIError, KaitenCard, KaitenClient, state_label

COMMAND_NAME = "mpu kiten"
COMMAND_SUMMARY = "Kaiten: `ls` — мои карточки (member); `whoami` — текущий пользователь"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def coalesce[T](*values: T | None) -> T | None:
    """Первое не-None значение (декларативный precedence: CLI > env > дефолт)."""
    return next((v for v in values if v is not None), None)


class LsState(StrEnum):
    queued = "queued"
    in_progress = "in-progress"
    done = "done"


_STATE_CODE = {LsState.queued: "1", LsState.in_progress: "2", LsState.done: "3"}

# Data-driven спека колонок таблицы `ls`: (заголовок, extractor карточки → ячейка).
_COLUMNS: tuple[tuple[str, Callable[[KaitenCard], str]], ...] = (
    ("ID", lambda c: str(c.id)),
    ("STATE", lambda c: state_label(c.state)),
    ("DUE", lambda c: (c.due_date or "")[:10]),
    ("TITLE", lambda c: c.title),
    ("URL", lambda c: c.url),
)


@dataclass
class LsFilters:
    condition: int | None
    states: str | None
    space_id: int | None
    board_id: int | None


def _parse_int(name: str, value: str) -> int:
    try:
        return int(value)
    except ValueError:
        raise typer.BadParameter(f"{name}={value!r}: ожидалось целое число") from None


def _env_int(env_get: Callable[[str], str | None], name: str) -> int | None:
    raw = env_get(name)
    return _parse_int(name, raw.strip()) if raw and raw.strip() else None


def _env_str(env_get: Callable[[str], str | None], name: str) -> str | None:
    raw = env_get(name)
    return raw.strip() if raw and raw.strip() else None


def resolve_ls_filters(
    *,
    env_get: Callable[[str], str | None],
    cli_archived: bool,
    cli_state: str | None,
    cli_space: int | None,
    cli_board: int | None,
) -> LsFilters:
    """Свести фильтры `ls` с precedence **CLI-флаг > env (KITEN_LS_*) > дефолт**.

    Чистая функция: env приходит callback'ом (не читается из процесса внутри),
    поэтому тестируется без сети и без правки окружения.
    """
    cli_states = _STATE_CODE[LsState(cli_state)] if cli_state is not None else None
    return LsFilters(
        # condition: --archived имеет высший приоритет; иначе env, иначе 1 (активные).
        condition=2 if cli_archived else coalesce(_env_int(env_get, "KITEN_LS_CONDITION"), 1),
        states=coalesce(cli_states, _env_str(env_get, "KITEN_LS_STATES")),
        space_id=coalesce(cli_space, _env_int(env_get, "KITEN_LS_SPACE_ID")),
        board_id=coalesce(cli_board, _env_int(env_get, "KITEN_LS_BOARD_ID")),
    )


@app.command("ls")
def ls(
    archived: Annotated[
        bool, typer.Option("--archived", help="Архивные карточки (condition=2) вместо активных")
    ] = False,
    state: Annotated[
        LsState | None, typer.Option("--state", help="Фильтр по этапу: queued|in-progress|done")
    ] = None,
    space_id: Annotated[
        int | None, typer.Option("--space", help="Ограничить пространством (space_id)")
    ] = None,
    board_id: Annotated[
        int | None, typer.Option("--board", help="Ограничить доской (board_id)")
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Карточки Kaiten, где я участник (member). Дефолты фильтров — из .env (KITEN_LS_*)."""
    from mpu.lib import env

    client = KaitenClient.from_env()
    try:
        me = client.current_user()
        filters = resolve_ls_filters(
            env_get=env.get,
            cli_archived=archived,
            cli_state=state.value if state is not None else None,
            cli_space=space_id,
            cli_board=board_id,
        )
        cards = client.list_cards(
            member_ids=str(me.id),
            condition=filters.condition,
            states=filters.states,
            space_id=filters.space_id,
            board_id=filters.board_id,
        )
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} ls: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None

    if out_json:
        typer.echo(_json.dumps([_card_dict(c) for c in cards], ensure_ascii=False, indent=2))
        return
    _print_cards(cards)


@app.command("whoami")
def whoami(
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо текста")] = False,
) -> None:
    """Текущий пользователь Kaiten по токену (GET /users/current)."""
    client = KaitenClient.from_env()
    try:
        me = client.current_user()
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} whoami: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None

    if out_json:
        payload = {
            "id": me.id,
            "full_name": me.full_name,
            "username": me.username,
            "email": me.email,
        }
        typer.echo(_json.dumps(payload, ensure_ascii=False))
        return
    typer.echo(f"id:    {me.id}")
    typer.echo(f"name:  {me.full_name}")
    typer.echo(f"login: {me.username}")
    typer.echo(f"email: {me.email}")


def _card_dict(c: KaitenCard) -> dict[str, object]:
    return {
        "id": c.id,
        "state": state_label(c.state),
        "due_date": c.due_date,
        "title": c.title,
        "url": c.url,
    }


def _print_cards(cards: list[KaitenCard]) -> None:
    if not cards:
        typer.echo("(нет карточек)")
        return
    table = Table(header_style="bold")
    for header, _extract in _COLUMNS:
        table.add_column(header, overflow="fold")
    for c in cards:
        table.add_row(*(extract(c) for _header, extract in _COLUMNS))
    Console().print(table)
    typer.echo(f"({len(cards)} cards)")
