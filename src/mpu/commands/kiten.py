"""`mpu kiten <ls|spaces|boards|lanes|whoami>` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten ls`     — карточки, где я участник (member). Фильтры по умолчанию из
  `.env` (KITEN_LS_*); CLI-флаг переопределяет **только свою** ось, остальные берутся
  из `.env`. `--space`/`--board`/`--lane`/`--column` принимают ID ИЛИ подстроку названия
  (резолв по кэшу). `--json` — машинный вывод.
- `mpu kiten spaces` — список пространств (ID — title); обновляет кэш автодополнения.
- `mpu kiten boards` — список досок (ID — title), `--space` фильтрует; обновляет кэш.
- `mpu kiten lanes`  — список дорожек (ID — title), `--space`/`--board` фильтруют; обновляет кэш.
- `mpu kiten columns`— список колонок (ID — title), `--space`/`--board` фильтруют; обновляет кэш.
- `mpu kiten whoami` — мой id / имя / email по токену (GET /users/current).

Справочник spaces/boards/lanes/columns для `--space`/`--board`/`--lane`/`--column` (резолв
подстроки + shell completion) кэшируется в `~/.config/mpu/mpu.db` командой `mpu init` или
`mpu kiten spaces/boards/lanes/columns` (см. `mpu.lib.kaiten_cache`). Дорожки и колонки
скоупятся по доске: при заданном `--board` (или env KITEN_LS_BOARD_ID) автодополнение
`--lane`/`--column` показывает только сущности этой доски.

ENV (~/.config/mpu/.env): KITEN_API_KEY, KITEN_BASE_URL, KITEN_LS_CONDITION,
KITEN_LS_STATES, KITEN_LS_SPACE_ID, KITEN_LS_BOARD_ID, KITEN_LS_LANE_ID, KITEN_LS_COLUMN_ID.

Стиль: фильтры сводятся декларативно через `coalesce(cli, env, default)` поосно, таблица
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

from mpu.lib import env, kaiten_cache
from mpu.lib.kaiten import KaitenAPIError, KaitenCard, KaitenClient, state_label

COMMAND_NAME = "mpu kiten"
COMMAND_SUMMARY = (
    "Kaiten: `ls` — мои карточки (member); `spaces`/`boards`/`lanes`/`columns` — справочник "
    "фильтров; `whoami` — текущий пользователь"
)

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


def _column_cell(card: KaitenCard, col_names: dict[int, str]) -> str:
    """Название колонки карточки по `column_id` (из кэша); фолбэк — id, иначе пусто."""
    if card.column_id is None:
        return ""
    return col_names.get(card.column_id, str(card.column_id))


# Data-driven спека колонок таблицы `ls`: (заголовок, extractor (карточка, col_names) → ячейка).
# col_names — карта column_id→title из кэша, нужна колонке COLUMN; остальные её игнорируют.
_COLUMNS: tuple[tuple[str, Callable[[KaitenCard, dict[int, str]], str]], ...] = (
    ("ID", lambda c, _cols: str(c.id)),
    ("STATE", lambda c, _cols: state_label(c.state)),
    ("COLUMN", _column_cell),
    ("DUE", lambda c, _cols: (c.due_date or "")[:10]),
    ("TITLE", lambda c, _cols: c.title),
    ("URL", lambda c, _cols: c.url),
)


@dataclass
class LsFilters:
    condition: int | None
    states: str | None
    space_id: int | None
    board_id: int | None
    lane_id: int | None = None
    column_id: int | None = None


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
    cli_lane: int | None = None,
    cli_column: int | None = None,
) -> LsFilters:
    """Свести фильтры `ls` с precedence **CLI-флаг > env (KITEN_LS_*) > дефолт**, **поосно**.

    Каждая ось независима: переданный CLI-флаг переопределяет только свою ось, остальные
    берутся из `.env` (или дефолта). Чистая функция: env приходит callback'ом (не читается
    из процесса внутри), поэтому тестируется без сети и без правки окружения.
    """
    cli_states = _STATE_CODE[LsState(cli_state)] if cli_state is not None else None
    return LsFilters(
        # condition: --archived имеет высший приоритет; иначе env, иначе 1 (активные).
        condition=2 if cli_archived else coalesce(_env_int(env_get, "KITEN_LS_CONDITION"), 1),
        states=coalesce(cli_states, _env_str(env_get, "KITEN_LS_STATES")),
        space_id=coalesce(cli_space, _env_int(env_get, "KITEN_LS_SPACE_ID")),
        board_id=coalesce(cli_board, _env_int(env_get, "KITEN_LS_BOARD_ID")),
        lane_id=coalesce(cli_lane, _env_int(env_get, "KITEN_LS_LANE_ID")),
        column_id=coalesce(cli_column, _env_int(env_get, "KITEN_LS_COLUMN_ID")),
    )


# ── Автодополнение / резолв --space, --board (ID или подстрока названия из кэша) ─


def _complete_space(incomplete: str) -> list[tuple[str, str]]:
    """TAB по --space: значение=ID, hint=title из кэша (`mpu init` / `mpu kiten spaces`)."""
    try:
        return kaiten_cache.filter_refs(incomplete, kaiten_cache.cached_spaces())
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _complete_board(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --board: доски из кэша; если уже задан --space — фильтр по нему."""
    try:
        space_ref = ctx.params.get("space")
        space_id: int | None = None
        if isinstance(space_ref, str) and space_ref.strip():
            try:
                space_id = kaiten_cache.resolve_ref(
                    space_ref, kaiten_cache.cached_spaces(), kind="space"
                )
            except ValueError:
                space_id = None
        return kaiten_cache.filter_refs(incomplete, kaiten_cache.cached_boards(space_id))
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_space(ref: str | None) -> int | None:
    """`--space` (ID или подстрока) → space_id. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_spaces(), kind="space")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _resolve_board(ref: str | None) -> int | None:
    """`--board` (ID или подстрока) → board_id. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_boards(), kind="board")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _board_id_from_ctx(ctx: typer.Context) -> int | None:
    """Эффективная доска для скоупа `--lane` в completion.

    Precedence как у самого `ls`: явный `--board` из текущей строки → иначе env
    `KITEN_LS_BOARD_ID` → иначе None (все дорожки). Best-effort, None при неоднозначности.
    """
    board_ref = ctx.params.get("board")
    if isinstance(board_ref, str) and board_ref.strip():
        try:
            return kaiten_cache.resolve_ref(board_ref, kaiten_cache.cached_boards(), kind="board")
        except ValueError:
            return None
    return _env_int(env.get, "KITEN_LS_BOARD_ID")


def _complete_lane(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --lane: дорожки из кэша; если задан --board — только дорожки этой доски."""
    try:
        return kaiten_cache.filter_refs(
            incomplete, kaiten_cache.cached_lanes(_board_id_from_ctx(ctx))
        )
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_lane(ref: str | None, board_id: int | None) -> int | None:
    """`--lane` (ID или подстрока) → lane_id в скоупе доски. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_lanes(board_id), kind="lane")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _complete_column(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --column: колонки из кэша; если задан --board (или env) — только этой доски."""
    try:
        return kaiten_cache.filter_refs(
            incomplete, kaiten_cache.cached_columns(_board_id_from_ctx(ctx))
        )
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_column(ref: str | None, board_id: int | None) -> int | None:
    """`--column` (ID или подстрока) → column_id в скоупе доски. ValueError → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_columns(board_id), kind="column")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


@app.command("ls")
def ls(
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
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Карточки Kaiten, где я участник (member). Дефолты фильтров — из .env (KITEN_LS_*)."""
    cli_space = _resolve_space(space)
    cli_board = _resolve_board(board)
    # Дорожка/колонка резолвятся в скоупе ЭФФЕКТИВНОЙ доски: явный --board, иначе env
    # KITEN_LS_BOARD_ID (так подстрока названия дизамбигуируется по той же доске, по
    # которой фильтрует ls по умолчанию).
    effective_board = coalesce(cli_board, _env_int(env.get, "KITEN_LS_BOARD_ID"))
    cli_lane = _resolve_lane(lane, effective_board)
    cli_column = _resolve_column(column, effective_board)
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
        )
        cards = client.list_cards(
            member_ids=str(me.id),
            condition=filters.condition,
            states=filters.states,
            space_id=filters.space_id,
            board_id=filters.board_id,
            lane_id=filters.lane_id,
            column_id=filters.column_id,
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


@app.command("spaces")
def spaces(
    show_all: Annotated[
        bool, typer.Option("--all", help="Показать и архивные пространства")
    ] = False,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Пространства Kaiten (живой GET /spaces + обновление кэша автодополнения)."""
    result = kaiten_cache.discover_and_store()
    if result.error:
        typer.echo(f"{COMMAND_NAME} spaces: kaiten error: {result.error}", err=True)
        raise typer.Exit(code=1)

    items = [s for s in result.spaces if show_all or not s.archived]
    if out_json:
        payload = [{"id": s.id, "title": s.title, "archived": s.archived} for s in items]
        typer.echo(_json.dumps(payload, ensure_ascii=False, indent=2))
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
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Доски Kaiten (живой GET /spaces + обновление кэша). --space фильтрует."""
    result = kaiten_cache.discover_and_store()
    if result.error:
        typer.echo(f"{COMMAND_NAME} boards: kaiten error: {result.error}", err=True)
        raise typer.Exit(code=1)

    space_id = _resolve_space(space)
    items = [b for b in result.boards if space_id is None or b.space_id == space_id]
    if out_json:
        payload = [{"id": b.id, "space_id": b.space_id, "title": b.title} for b in items]
        typer.echo(_json.dumps(payload, ensure_ascii=False, indent=2))
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
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Дорожки досок Kaiten (живой GET /boards/{id}/lanes + обновление кэша).

    Без фильтра обходит все доски (по одному запросу на доску). `--board` ограничивает
    одной доской (1 запрос), `--space` — досками пространства.
    """
    disc = kaiten_cache.discover_and_store()
    if disc.error:
        typer.echo(f"{COMMAND_NAME} lanes: kaiten error: {disc.error}", err=True)
        raise typer.Exit(code=1)

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
        typer.echo(f"{COMMAND_NAME} lanes: kaiten error: {result.error}", err=True)
        raise typer.Exit(code=1)

    if out_json:
        payload = [{"id": ln.id, "board_id": ln.board_id, "title": ln.title} for ln in result.lanes]
        typer.echo(_json.dumps(payload, ensure_ascii=False, indent=2))
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
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """Колонки досок Kaiten (живой GET /boards/{id}/columns + обновление кэша).

    Без фильтра обходит все доски (по одному запросу на доску). `--board` ограничивает
    одной доской (1 запрос), `--space` — досками пространства.
    """
    disc = kaiten_cache.discover_and_store()
    if disc.error:
        typer.echo(f"{COMMAND_NAME} columns: kaiten error: {disc.error}", err=True)
        raise typer.Exit(code=1)

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
        typer.echo(f"{COMMAND_NAME} columns: kaiten error: {result.error}", err=True)
        raise typer.Exit(code=1)

    if out_json:
        payload = [{"id": c.id, "board_id": c.board_id, "title": c.title} for c in result.columns]
        typer.echo(_json.dumps(payload, ensure_ascii=False, indent=2))
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
    col_names = dict(kaiten_cache.cached_columns())  # id→title для колонки COLUMN
    table = Table(header_style="bold")
    for header, _extract in _COLUMNS:
        table.add_column(header, overflow="fold")
    for c in cards:
        table.add_row(*(extract(c, col_names) for _header, extract in _COLUMNS))
    Console().print(table)
    typer.echo(f"({len(cards)} cards)")
