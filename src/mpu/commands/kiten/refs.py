"""`mpu kiten whoami`/`spaces`/`boards`/`lanes`/`columns` — я по токену + справочник
пространств/досок/дорожек/колонок (живой GET + обновление кэша автодополнения)."""

from __future__ import annotations

import json as _json
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import (
    COMMAND_NAME,
    JsonOpt,
    _complete_board,
    _complete_space,
    _resolve_board,
    _resolve_space,
)
from mpu.lib import kaiten_cache
from mpu.lib.cli_err import die
from mpu.lib.cli_out import print_json
from mpu.lib.kaiten import KaitenAPIError, KaitenClient


@app.command("whoami")
def whoami(
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо текста")] = False,
) -> None:
    """Текущий пользователь Kaiten по токену (GET /users/current)."""
    client = KaitenClient.from_env()
    try:
        me = client.current_user()
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} whoami: kaiten error: {e}")

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


@app.command("spaces")
def spaces(
    show_all: Annotated[
        bool, typer.Option("--all", help="Показать и архивные пространства")
    ] = False,
    out_json: JsonOpt = False,
) -> None:
    """Пространства Kaiten (живой GET /spaces + обновление кэша автодополнения)."""
    result = kaiten_cache.discover_and_store()
    if result.error:
        die(f"{COMMAND_NAME} spaces: kaiten error: {result.error}")

    items = [s for s in result.spaces if show_all or not s.archived]
    if out_json:
        payload = [{"id": s.id, "title": s.title, "archived": s.archived} for s in items]
        print_json(payload)
        return
    if not items:
        typer.echo("(нет пространств)")
        return
    table = Table(header_style="bold")
    for header in ("ID", "TITLE", "ARCHIVED"):
        table.add_column(header, overflow="fold")
    for s in items:
        table.add_row(str(s.id), s.title, "yes" if s.archived else "")
    Console().print(table)
    typer.echo(f"({len(items)} spaces)")


@app.command("roles")
def roles(
    show_all: Annotated[
        bool, typer.Option("--all", help="Показать и системные роли (Employee)")
    ] = False,
    out_json: JsonOpt = False,
) -> None:
    """Роли компании = «типы работ» для `mpu kiten time` (живой GET /user-roles + кэш).

    Кэш нужен, чтобы `--role техподдержка` резолвился по подстроке названия и работало
    автодополнение. Системная роль Employee (ID -1) по умолчанию скрыта: временем её
    не помечают, а в списке она только мешает.
    """
    result = kaiten_cache.discover_roles_and_store()
    if result.error:
        die(f"{COMMAND_NAME} roles: kaiten error: {result.error}")

    items = [r for r in result.roles if show_all or r.id > 0]
    if out_json:
        print_json([{"id": r.id, "name": r.name} for r in items])
        return
    if not items:
        typer.echo("(нет ролей)")
        return
    table = Table(header_style="bold")
    for header in ("ID", "NAME"):
        table.add_column(header, overflow="fold")
    for r in items:
        table.add_row(str(r.id), r.name)
    Console().print(table)
    typer.echo(f"({len(items)} roles)")


@app.command("boards")
def boards(
    space: Annotated[
        str | None,
        typer.Option(
            "--space",
            help="Фильтр по пространству: ID или подстрока названия",
            autocompletion=_complete_space,
        ),
    ] = None,
    out_json: JsonOpt = False,
) -> None:
    """Доски Kaiten (живой GET /spaces + обновление кэша). --space фильтрует."""
    result = kaiten_cache.discover_and_store()
    if result.error:
        die(f"{COMMAND_NAME} boards: kaiten error: {result.error}")

    space_id = _resolve_space(space)
    items = [b for b in result.boards if space_id is None or b.space_id == space_id]
    if out_json:
        payload = [{"id": b.id, "space_id": b.space_id, "title": b.title} for b in items]
        print_json(payload)
        return
    if not items:
        typer.echo("(нет досок)")
        return
    table = Table(header_style="bold")
    for header in ("ID", "SPACE", "TITLE"):
        table.add_column(header, overflow="fold")
    for b in items:
        table.add_row(str(b.id), str(b.space_id), b.title)
    Console().print(table)
    typer.echo(f"({len(items)} boards)")


@app.command("lanes")
def lanes(
    space: Annotated[
        str | None,
        typer.Option(
            "--space",
            help="Фильтр по пространству: ID или подстрока названия",
            autocompletion=_complete_space,
        ),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board",
            help="Фильтр по доске: ID или подстрока названия",
            autocompletion=_complete_board,
        ),
    ] = None,
    out_json: JsonOpt = False,
) -> None:
    """Дорожки досок Kaiten (живой GET /boards/{id}/lanes + обновление кэша).

    Без фильтра обходит все доски (по одному запросу на доску). `--board` ограничивает
    одной доской (1 запрос), `--space` — досками пространства.
    """
    disc = kaiten_cache.discover_and_store()
    if disc.error:
        die(f"{COMMAND_NAME} lanes: kaiten error: {disc.error}")

    space_id = _resolve_space(space)
    board_id = _resolve_board(board)
    if board_id is not None:
        target = [b for b in disc.boards if b.id == board_id]
    elif space_id is not None:
        target = [b for b in disc.boards if b.space_id == space_id]
    else:
        target = disc.boards

    result = kaiten_cache.discover_lanes_and_store([b.id for b in target])
    if result.error:
        die(f"{COMMAND_NAME} lanes: kaiten error: {result.error}")

    if out_json:
        payload = [{"id": ln.id, "board_id": ln.board_id, "title": ln.title} for ln in result.lanes]
        print_json(payload)
        return
    if not result.lanes:
        typer.echo("(нет дорожек)")
        return
    table = Table(header_style="bold")
    for header in ("ID", "BOARD", "TITLE"):
        table.add_column(header, overflow="fold")
    for ln in result.lanes:
        table.add_row(str(ln.id), str(ln.board_id), ln.title)
    Console().print(table)
    typer.echo(f"({len(result.lanes)} lanes)")


@app.command("columns")
def columns(
    space: Annotated[
        str | None,
        typer.Option(
            "--space",
            help="Фильтр по пространству: ID или подстрока названия",
            autocompletion=_complete_space,
        ),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board",
            help="Фильтр по доске: ID или подстрока названия",
            autocompletion=_complete_board,
        ),
    ] = None,
    out_json: JsonOpt = False,
) -> None:
    """Колонки досок Kaiten (живой GET /boards/{id}/columns + обновление кэша).

    Без фильтра обходит все доски (по одному запросу на доску). `--board` ограничивает
    одной доской (1 запрос), `--space` — досками пространства.
    """
    disc = kaiten_cache.discover_and_store()
    if disc.error:
        die(f"{COMMAND_NAME} columns: kaiten error: {disc.error}")

    space_id = _resolve_space(space)
    board_id = _resolve_board(board)
    if board_id is not None:
        target = [b for b in disc.boards if b.id == board_id]
    elif space_id is not None:
        target = [b for b in disc.boards if b.space_id == space_id]
    else:
        target = disc.boards

    result = kaiten_cache.discover_columns_and_store([b.id for b in target])
    if result.error:
        die(f"{COMMAND_NAME} columns: kaiten error: {result.error}")

    if out_json:
        payload = [{"id": c.id, "board_id": c.board_id, "title": c.title} for c in result.columns]
        print_json(payload)
        return
    if not result.columns:
        typer.echo("(нет колонок)")
        return
    table = Table(header_style="bold")
    for header in ("ID", "BOARD", "TITLE"):
        table.add_column(header, overflow="fold")
    for col in result.columns:
        table.add_row(str(col.id), str(col.board_id), col.title)
    Console().print(table)
    typer.echo(f"({len(result.columns)} columns)")
