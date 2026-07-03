"""`mpu kiten ls` — карточки, где я участник (member); свод фильтров CLI>env>дефолт."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

import typer

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import (
    COMMAND_NAME,
    _complete_board,
    _complete_column,
    _complete_lane,
    _complete_space,
    _env_int,
    _env_str,
    _load_column_map,
    _resolve_board,
    _resolve_column,
    _resolve_lane,
    _resolve_space,
    build_updated_window,
    coalesce,
)
from mpu.commands.kiten._render import (
    _card_dict,
    _cards_to_md_table,
    _format_card,
    _md_link_text,
    _print_cards,
)
from mpu.lib import env, kaiten_cache
from mpu.lib.cli_out import print_json
from mpu.lib.kaiten import KaitenAPIError, KaitenClient


class LsState(StrEnum):
    queued = "queued"
    in_progress = "in-progress"
    done = "done"


_STATE_CODE = {LsState.queued: "1", LsState.in_progress: "2", LsState.done: "3"}


@dataclass
class LsFilters:
    condition: int | None
    states: str | None
    space_id: int | None
    board_id: int | None
    lane_id: int | None = None
    column_id: int | None = None


def resolve_ls_filters(
    *,
    env_get: Callable[[str], str | None],
    cli_archived: bool,
    cli_state: str | None,
    cli_space: int | None,
    cli_board: int | None,
    cli_lane: int | None = None,
    cli_column: int | None = None,
    scope_all: bool = False,
) -> LsFilters:
    """Свести фильтры `ls` с precedence **CLI-флаг > env (KITEN_LS_*) > дефолт**, **поосно**.

    Каждая ось независима: переданный CLI-флаг переопределяет только свою ось, остальные
    берутся из `.env` (или дефолта). Чистая функция: env приходит callback'ом (не читается
    из процесса внутри), поэтому тестируется без сети и без правки окружения.

    `scope_all=True` (включается при заданной дате `--date-from`/`--date-to`): env-скоуп
    (`KITEN_LS_*`) НЕ применяется — поиск глобальный по всем доскам, а `condition` по
    умолчанию — `None` (и активные, и архивные → завершённые и отправленные в архив).
    Явные CLI-флаги всё ещё сужают («если в фильтре указано иное»).
    """
    cli_states = _STATE_CODE[LsState(cli_state)] if cli_state is not None else None
    if scope_all:
        return LsFilters(
            # condition: --archived → только архив; иначе None → и активные, и архивные.
            condition=2 if cli_archived else None,
            states=cli_states,
            space_id=cli_space,
            board_id=cli_board,
            lane_id=cli_lane,
            column_id=cli_column,
        )
    return LsFilters(
        # condition: --archived имеет высший приоритет; иначе env, иначе 1 (активные).
        condition=2 if cli_archived else coalesce(_env_int(env_get, "KITEN_LS_CONDITION"), 1),
        states=coalesce(cli_states, _env_str(env_get, "KITEN_LS_STATES")),
        space_id=coalesce(cli_space, _env_int(env_get, "KITEN_LS_SPACE_ID")),
        board_id=coalesce(cli_board, _env_int(env_get, "KITEN_LS_BOARD_ID")),
        lane_id=coalesce(cli_lane, _env_int(env_get, "KITEN_LS_LANE_ID")),
        column_id=coalesce(cli_column, _env_int(env_get, "KITEN_LS_COLUMN_ID")),
    )


@app.command("ls")
def ls(  # noqa: PLR0913
    archived: Annotated[
        bool, typer.Option("--archived", help="Архивные карточки (condition=2) вместо активных")
    ] = False,
    state: Annotated[
        LsState | None, typer.Option("--state", help="Фильтр по этапу: queued|in-progress|done")
    ] = None,
    space: Annotated[
        str | None,
        typer.Option(
            "--space",
            help="Пространство: ID или подстрока названия (см. `mpu kiten spaces`)",
            autocompletion=_complete_space,
        ),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board",
            help="Доска: ID или подстрока названия (см. `mpu kiten boards`)",
            autocompletion=_complete_board,
        ),
    ] = None,
    lane: Annotated[
        str | None,
        typer.Option(
            "--lane",
            help="Дорожка: ID или подстрока названия (в скоупе --board; см. `mpu kiten lanes`)",
            autocompletion=_complete_lane,
        ),
    ] = None,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Колонка: ID или подстрока названия (в скоупе --board; см. `mpu kiten columns`)",
            autocompletion=_complete_column,
        ),
    ] = None,
    date_from: Annotated[
        str | None,
        typer.Option(
            "--date-from",
            "--date_from",
            help="Активность ОТ даты (YYYY-MM-DD), updated_after; опущено — без нижней границы",
        ),
    ] = None,
    date_to: Annotated[
        str | None,
        typer.Option(
            "--date-to",
            "--date_to",
            help="Активность ДО даты (YYYY-MM-DD), updated_before; опущено — до сейчас",
        ),
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
    md: Annotated[
        bool,
        typer.Option("--md", help="Markdown-вывод: GFM-таблица (с --only-url — строки ссылок)"),
    ] = False,
    only_url: Annotated[
        bool,
        typer.Option(
            "--only-url",
            help="Только ссылки [title](url), по одной на строку (пайп в `mpu telegram send --md`)",
        ),
    ] = False,
    out_format: Annotated[
        str | None,
        typer.Option(
            "--format",
            help="Шаблон строки: {n} {id} {title} {url} {state} {due} {column} {column_mapped}",
        ),
    ] = None,
) -> None:
    """Карточки Kaiten, где я участник (member). Дефолты фильтров — из .env (KITEN_LS_*).

    `--date-from`/`--date-to` (YYYY-MM-DD) задают окно активности (поле `updated`); обе
    опции CLI-only и необязательны. `--date-from X` без `--date-to` = «с даты X до сейчас».

    Наличие даты переводит `ls` в **глобальный** режим: env-скоуп (`KITEN_LS_*`, в т.ч.
    доска по умолчанию) отключается, поиск идёт по всем доскам, а в выдачу попадают и
    архивные, и завершённые карточки (`condition` не ограничен). Любой явный флаг
    (`--board`/`--space`/`--lane`/`--column`/`--state`/`--archived`) всё ещё сужает. Без
    даты поведение прежнее (env-скоуп, только активные).
    """
    # Заданная дата → глобальный поиск: env-скоуп (включая дефолтную доску) отключается.
    scope_all = bool(date_from or date_to)
    cli_space = _resolve_space(space)
    cli_board = _resolve_board(board)
    # Дорожка/колонка резолвятся в скоупе ЭФФЕКТИВНОЙ доски: явный --board, иначе (вне
    # глобального режима) env KITEN_LS_BOARD_ID — так подстрока названия дизамбигуируется
    # по той же доске, по которой фильтрует ls по умолчанию.
    effective_board = (
        cli_board if scope_all else coalesce(cli_board, _env_int(env.get, "KITEN_LS_BOARD_ID"))
    )
    cli_lane = _resolve_lane(lane, effective_board)
    cli_column = _resolve_column(column, effective_board)
    updated_after, updated_before = build_updated_window(date_from, date_to)
    client = KaitenClient.from_env()
    try:
        me = client.current_user()
        filters = resolve_ls_filters(
            env_get=env.get,
            cli_archived=archived,
            cli_state=state.value if state is not None else None,
            cli_space=cli_space,
            cli_board=cli_board,
            cli_lane=cli_lane,
            cli_column=cli_column,
            scope_all=scope_all,
        )
        cards = client.list_cards(
            member_ids=str(me.id),
            condition=filters.condition,
            states=filters.states,
            space_id=filters.space_id,
            board_id=filters.board_id,
            lane_id=filters.lane_id,
            column_id=filters.column_id,
            updated_after=updated_after,
            updated_before=updated_before,
        )
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} ls: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None

    if out_json:
        print_json([_card_dict(c) for c in cards])
        return
    if out_format is not None:
        col_names = dict(kaiten_cache.cached_columns())
        col_map = _load_column_map()
        for i, c in enumerate(cards, start=1):
            typer.echo(_format_card(out_format, i, c, col_names, col_map))
        return
    if only_url:
        for c in cards:
            typer.echo(f"[{_md_link_text(c.title)}]({c.url})")
        return
    if md:
        typer.echo(_cards_to_md_table(cards, dict(kaiten_cache.cached_columns())))
        return
    _print_cards(cards)
