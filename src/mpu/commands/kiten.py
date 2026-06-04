"""`mpu kiten <ls|card|spaces|boards|lanes|whoami>` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten ls`     — карточки, где я участник (member). Фильтры по умолчанию из
  `.env` (KITEN_LS_*); CLI-флаг переопределяет **только свою** ось, остальные берутся
  из `.env`. `--space`/`--board`/`--lane`/`--column` принимают ID ИЛИ подстроку названия
  (резолв по кэшу). `--date-from`/`--date-to` (YYYY-MM-DD, CLI-only) — окно активности
  (`updated`); их наличие включает **глобальный** поиск (по всем доскам, плюс архив и
  завершённые), env-скоуп игнорируется, но явные флаги всё ещё сужают. Без даты вывод как
  раньше. `--json` — машинный вывод.
- `mpu kiten card <selector>` — одна карточка наглядно: markdown + GFM-таблицы + инлайн-
  скриншоты (notebook-flow через rich + term-image). Селектор — id ИЛИ URL btlz.kaiten.ru
  (короткий `/65634936` или глубокий `.../boards/card/65634936?filter=…`). `--md` — чистый
  GFM для LLM (ссылки/таблицы целы, без ANSI; авто при пайпе); `--json` — сырой JSON.
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

import datetime
import json as _json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from mpu.lib import env, kaiten_cache, kaiten_render
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenCard,
    KaitenCardDetail,
    KaitenClient,
    KaitenComment,
    KaitenMember,
    parse_card_ref,
    state_label,
)

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


# ── Окно активности --date-from / --date-to (YYYY-MM-DD → updated_after/before) ──


def _check_date(flag: str, value: str) -> str:
    """Валидировать YYYY-MM-DD; вернуть нормализованную строку, иначе BadParameter."""
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        raise typer.BadParameter(f"{flag}={value!r}: ожидается YYYY-MM-DD") from None


def build_updated_window(
    date_from: str | None, date_to: str | None
) -> tuple[str | None, str | None]:
    """`--date-from`/`--date-to` (YYYY-MM-DD) → `(updated_after, updated_before)` в ISO 8601 (UTC).

    Окно по последней активности карточки (поле `updated`). Границы инклюзивные: from —
    начало дня (`T00:00:00Z`), to — конец дня (`T23:59:59Z`). `None` остаётся `None` (ось
    не фильтруется), так что без обоих флагов `ls` работает как раньше. Чистая функция
    (только валидация + формат), сети нет — тестируется без моков. Невалидная дата —
    `BadParameter`, как у `_resolve_*`.
    """
    updated_after = f"{_check_date('--date-from', date_from)}T00:00:00Z" if date_from else None
    updated_before = f"{_check_date('--date-to', date_to)}T23:59:59Z" if date_to else None
    return updated_after, updated_before


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
        typer.echo(_json.dumps([_card_dict(c) for c in cards], ensure_ascii=False, indent=2))
        return
    _print_cards(cards)


@app.command("card")
def card(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    md: Annotated[
        bool, typer.Option("--md", help="Чистый GFM markdown для LLM (без ANSI/картинок)")
    ] = False,
    out_json: Annotated[bool, typer.Option("--json", help="Сырой JSON (card + comments)")] = False,
    images: Annotated[
        bool, typer.Option("--images/--no-images", help="Инлайн-скриншоты в наглядном режиме")
    ] = True,
    comments: Annotated[
        bool, typer.Option("--comments/--no-comments", help="Включать комментарии")
    ] = True,
) -> None:
    """Одна карточка Kaiten: наглядный рендер (markdown + таблицы + скриншоты), либо
    `--md` (чистый GFM для LLM), либо `--json`. При пайпе по умолчанию — markdown."""
    try:
        card_id = parse_card_ref(selector)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None
    client = KaitenClient.from_env()
    try:
        detail = client.get_card(card_id)
        comment_list = client.get_comments(card_id) if comments else []
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} card: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None

    prop_names = kaiten_cache.property_names()
    if out_json:
        typer.echo(
            _json.dumps(_card_detail_dict(detail, comment_list), ensure_ascii=False, indent=2)
        )
        return
    # Пайп (не TTY) и не --json → markdown: `mpu kiten card X | <llm>` отдаёт чистый GFM.
    if md or not sys.stdout.isatty():
        typer.echo(_card_to_markdown(detail, comment_list, prop_names))
        return
    _render_card_rich(detail, comment_list, prop_names, images=images)


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
        "updated": c.updated,
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


# ── card: рендер одной карточки ─────────────────────────────────────────────────


def _format_property(key: str, value: str, prop_names: dict[int, str]) -> str:
    """`id_NNN` + значение → `- {имя поля}: {значение}` (имя из кэша; фолбэк — сырой ключ)."""
    name = key
    if key.startswith("id_"):
        try:
            name = prop_names.get(int(key[3:]), key)
        except ValueError:
            name = key
    return f"- {name}: {value}"


def _comment_head(comment: KaitenComment) -> str:
    """Шапка комментария: автор + дата (YYYY-MM-DD HH:MM)."""
    head = comment.author_name or "—"
    if comment.created:
        head += f" · {comment.created[:16].replace('T', ' ')}"
    return head


def _card_to_markdown(
    detail: KaitenCardDetail, comments: list[KaitenComment], prop_names: dict[int, str]
) -> str:
    """Карточка → чистый GFM markdown для LLM. Ссылки/таблицы/`![](url)` — дословно."""
    lines: list[str] = [f"# {detail.title}", ""]
    if detail.key:
        lines.append(f"- **Key**: {detail.key}")
    lines.append(f"- **URL**: {detail.url}")
    lines.append(f"- **Этап**: {state_label(detail.state)}")
    loc = " · ".join(x for x in (detail.board_title, detail.column_title, detail.lane_title) if x)
    if loc:
        lines.append(f"- **Доска**: {loc}")
    if detail.owner:
        lines.append(f"- **Владелец**: {detail.owner.full_name}")
    if detail.members:
        lines.append(f"- **Участники**: {', '.join(m.full_name for m in detail.members)}")
    if detail.due_date:
        lines.append(f"- **Дедлайн**: {detail.due_date[:10]}")
    if detail.tags:
        lines.append(f"- **Теги**: {', '.join(detail.tags)}")
    lines.append("")

    if detail.properties:
        lines.append("## Свойства")
        lines.append("")
        lines.extend(_format_property(k, v, prop_names) for k, v in detail.properties.items())
        lines.append("")

    lines.append("## Описание")
    lines.append("")
    lines.append(detail.description or "_нет описания_")
    lines.append("")

    if detail.files:
        lines.append("## Файлы")
        lines.append("")
        lines.extend(f"- [{f.name or f.url}]({f.url})" for f in detail.files)
        lines.append("")

    if comments:
        lines.append("## Комментарии")
        lines.append("")
        for c in comments:
            lines.append(f"### {_comment_head(c)}")
            lines.append("")
            lines.append(c.text)
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _member_dict(member: KaitenMember) -> dict[str, object]:
    return {
        "id": member.id,
        "full_name": member.full_name,
        "email": member.email,
        "username": member.username,
    }


def _card_detail_dict(
    detail: KaitenCardDetail, comments: list[KaitenComment]
) -> dict[str, object]:
    return {
        "id": detail.id,
        "key": detail.key,
        "title": detail.title,
        "state": state_label(detail.state),
        "condition": detail.condition,
        "due_date": detail.due_date,
        "board": detail.board_title,
        "column": detail.column_title,
        "lane": detail.lane_title,
        "size_text": detail.size_text,
        "created": detail.created,
        "updated": detail.updated,
        "type": detail.type_name,
        "tags": detail.tags,
        "url": detail.url,
        "owner": _member_dict(detail.owner) if detail.owner else None,
        "members": [_member_dict(m) for m in detail.members],
        "properties": detail.properties,
        "description": detail.description,
        "files": [
            {
                "id": f.id,
                "name": f.name,
                "url": f.url,
                "mime_type": f.mime_type,
                "comment_id": f.comment_id,
                "card_cover": f.card_cover,
            }
            for f in detail.files
        ],
        "comments": [
            {"id": c.id, "author": c.author_name, "created": c.created, "text": c.text}
            for c in comments
        ],
    }


def _render_card_rich(
    detail: KaitenCardDetail,
    comments: list[KaitenComment],
    prop_names: dict[int, str],
    *,
    images: bool,
) -> None:
    """Наглядный TTY-рендер: шапка-панель + markdown с инлайн-скриншотами на своих местах."""
    console = Console()

    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="bold cyan", justify="right")
    grid.add_column(overflow="fold")
    if detail.key:
        grid.add_row("Key", str(detail.key))
    grid.add_row("Этап", state_label(detail.state))
    loc = " · ".join(x for x in (detail.board_title, detail.column_title, detail.lane_title) if x)
    if loc:
        grid.add_row("Доска", loc)
    if detail.owner:
        grid.add_row("Владелец", detail.owner.full_name)
    if detail.members:
        grid.add_row("Участники", ", ".join(m.full_name for m in detail.members))
    if detail.due_date:
        grid.add_row("Дедлайн", detail.due_date[:10])
    if detail.tags:
        grid.add_row("Теги", ", ".join(detail.tags))
    grid.add_row("URL", detail.url)
    console.print(Panel(grid, title=detail.title, title_align="left", border_style="cyan"))

    if detail.properties:
        console.print("\n[bold]Свойства[/bold]")
        props_md = "\n".join(
            _format_property(k, v, prop_names) for k, v in detail.properties.items()
        )
        kaiten_render.render_markdown_with_images(console, props_md, images=False)

    console.print("\n[bold]Описание[/bold]")
    kaiten_render.render_markdown_with_images(
        console, detail.description or "_нет описания_", images=images
    )

    seen: set[str] = set(kaiten_render.inline_image_urls(detail.description or ""))
    if comments:
        console.print("\n[bold]Комментарии[/bold]")
        for c in comments:
            console.print(f"\n[bold green]{_comment_head(c)}[/bold green]")
            kaiten_render.render_markdown_with_images(console, c.text, images=images)
            seen.update(kaiten_render.inline_image_urls(c.text))

    # Вложения-картинки карточки (comment_id=null), не встретившиеся инлайн.
    extra = [f for f in detail.files if kaiten_render.is_image_url(f.url) and f.url not in seen]
    if extra:
        console.print("\n[bold]Вложения[/bold]")
        for f in extra:
            console.print(f"[dim]{f.name}[/dim]")
            data = kaiten_render.fetch_image_bytes(f.url) if images else None
            if data is not None and kaiten_render.render_image(data):
                continue
            console.print(f"[link={f.url}]🖼 {f.url}[/link]")
