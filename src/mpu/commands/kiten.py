"""`mpu kiten` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten ls`     — карточки, где я участник (member). Фильтры по умолчанию из
  `.env` (KITEN_LS_*); CLI-флаг переопределяет **только свою** ось, остальные берутся
  из `.env`. `--space`/`--board`/`--lane`/`--column` принимают ID ИЛИ подстроку названия
  (резолв по кэшу). `--date-from`/`--date-to` (YYYY-MM-DD, CLI-only) — окно активности
  (`updated`); их наличие включает **глобальный** поиск (по всем доскам, плюс архив и
  завершённые), env-скоуп игнорируется, но явные флаги всё ещё сужают. Без даты вывод как
  раньше. Вывод: `--json` (машинный); `--only-url` (строки `[title](url)`); `--md`
  (GFM-таблица); `--format '<шаблон>'` — произвольный шаблон с плейсхолдерами `{n}` `{id}`
  `{title}` `{url}` `{state}` `{due}` `{column}` `{column_mapped}`. `{column_mapped}` берёт
  метку из `.env` `KITEN_COLUMN_MAP` (JSON: id-ИЛИ-имя колонки → метка), иначе исходное имя.
- `mpu kiten card <selector>` — одна карточка наглядно: markdown + GFM-таблицы + инлайн-
  скриншоты (notebook-flow через rich + term-image). Селектор — id ИЛИ URL btlz.kaiten.ru
  (короткий `/65634936` или глубокий `.../boards/card/65634936?filter=…`). `--md` — чистый
  GFM для LLM (ссылки/таблицы целы, без ANSI; авто при пайпе); `--json` — сырой JSON.
- `mpu kiten comment <selector> <-m TEXT | -F FILE>` — добавить комментарий от своего имени
  (автор — владелец `KITEN_API_KEY`). Тело из `-m`/`--message` ИЛИ `-F`/`--body-file`
  (`-` = stdin), как у `mpu mr comment`. Селектор — как у `card`.
- `mpu kiten move <selector> [--lane L] [--column C] [--board B]` — переместить карточку по
  дорожке / колонке / доске (хотя бы одна ось). `--lane`/`--column` принимают ID или подстроку,
  резолв в скоупе целевой доски (`--board`, иначе текущая доска карточки).
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
KITEN_LS_STATES, KITEN_LS_SPACE_ID, KITEN_LS_BOARD_ID, KITEN_LS_LANE_ID, KITEN_LS_COLUMN_ID,
KITEN_COLUMN_MAP (JSON id-или-имя колонки → метка, для `--format {column_mapped}`).

Стиль: фильтры сводятся декларативно через `coalesce(cli, env, default)` поосно, таблица
описана data-driven спекой колонок `_COLUMNS` и рендерится через rich.
"""

from __future__ import annotations

import datetime
import json as _json
import re
import sqlite3
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Annotated, cast

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from mpu.lib import env, kaiten_cache, kaiten_links, kaiten_render, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenCard,
    KaitenCardDetail,
    KaitenClient,
    KaitenComment,
    KaitenMember,
    card_url,
    parse_card_ref,
    state_label,
)

COMMAND_NAME = "mpu kiten"
COMMAND_SUMMARY = (
    "Kaiten: `ls` — мои карточки (member); `card` — одна карточка; `comment` — комментарий; "
    "`move`/`ready`/`review` — перемещение (+ лог в журнал); "
    "`spaces`/`boards`/`lanes`/`columns` — справочник; `whoami`"
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


def _parse_card_ref(ref: str) -> int:
    """Селектор карточки → id; ValueError парсера → BadParameter."""
    try:
        return parse_card_ref(ref)
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
        typer.echo(_json.dumps([_card_dict(c) for c in cards], ensure_ascii=False, indent=2))
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
    card_id = _parse_card_ref(selector)
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


def resolve_comment_text(
    message: str | None,
    body_file: str | None,
    *,
    stdin_read: Callable[[], str],
    require_text: bool = True,
) -> str:
    """Текст комментария из ровно одного источника: `-m TEXT` или `-F PATH` (`-` — stdin).

    Чистая функция (stdin приходит callback'ом, файл читается по пути) — тестируется без
    сети. Зеркало `mpu mr`.resolve_body, держится локально, чтобы `mpu kiten` не тянул
    зависимости command-модуля mr.

    `require_text=False` (есть вложения) — текст необязателен: оба источника опущены → `""`,
    пустой текст не считается ошибкой (комментарий-вложение без подписи допустим).
    """
    if message is not None and body_file is not None:
        raise typer.BadParameter("нельзя одновременно -m/--message и -F/--body-file")
    if message is None and body_file is None:
        if require_text:
            raise typer.BadParameter("нужно ровно одно из -m/--message и -F/--body-file")
        return ""
    if message is not None:
        text = message
    elif body_file == "-":
        text = stdin_read()
    else:
        try:
            text = Path(str(body_file)).read_text(encoding="utf-8")
        except OSError as e:
            raise typer.BadParameter(f"не удалось прочитать {body_file}: {e}") from None
    if require_text and not text.strip():
        raise typer.BadParameter("пустой текст комментария")
    return text


def read_attachments(paths: list[str]) -> list[tuple[str, bytes]]:
    """Прочитать файлы-вложения по путям → `[(имя_файла, байты)]` (в порядке аргументов).

    Несуществующий путь или не обычный файл → `typer.BadParameter` (не голый `OSError`),
    чтобы CLI дал понятную ошибку. Имя в Kaiten — базовое имя файла (без каталога).
    """
    out: list[tuple[str, bytes]] = []
    for path in paths:
        p = Path(path)
        if not p.is_file():
            raise typer.BadParameter(f"файл-вложение не найден: {path}")
        try:
            out.append((p.name, p.read_bytes()))
        except OSError as e:
            raise typer.BadParameter(f"не удалось прочитать вложение {path}: {e}") from None
    return out


# В Kaiten нет литерального «@all»: упоминание — это plain-текст `@username`, который сервер
# резолвит в реальный логин и уведомляет. `@all` сам по себе не логин → не уведомляет.
# Токен ловим как самостоятельный (в начале строки/после пробела, не часть e-mail/слова).
ALL_MENTION_RE = re.compile(r"(?<!\S)@all(?!\w)", re.IGNORECASE)


def expand_all_mention(text: str, handles: list[str]) -> str:
    """Развернуть токен `@all` в перечисление `@handle` (обычно — `@username` владельца карточки).

    Чистая функция (логины приходят аргументом). Пустой `handles` → текст без изменений
    (разворачивать нечего, литеральный `@all` оставляем как есть — он безвреден).
    """
    if not handles:
        return text
    mention = " ".join(f"@{h}" for h in handles)
    return ALL_MENTION_RE.sub(lambda _m: mention, text)


def _expand_all_to_owner(text: str, card: KaitenCardDetail) -> tuple[str, list[str]]:
    """`@all` → `@{username владельца карточки}` (заказчик). Возврат: (новый текст, упомянутые).

    Нет токена `@all` → текст без изменений и `[]`. Нет владельца/username → текст как есть и `[]`
    (вызывающий предупреждает). Владелец один, поэтому список — не более одного логина.
    """
    if not ALL_MENTION_RE.search(text):
        return text, []
    owner = card.owner
    if owner and owner.username:
        return expand_all_mention(text, [owner.username]), [owner.username]
    return text, []


def parse_recipients(values: list[str]) -> list[str]:
    """`--to` (повторяемый; каждое значение — один или несколько хэндлов через пробел) →
    плоский список токенов в порядке появления, без дублей (без учёта регистра), с ведущим `@`.

    `@all` сохраняется как есть — раскрывается в владельца карточки на следующем шаге
    (`expand_recipients`). Чистая функция.
    """
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        for token in value.split():
            handle = token if token.startswith("@") else f"@{token}"
            key = handle.lower()
            if key not in seen:
                seen.add(key)
                out.append(handle)
    return out


def expand_recipients(tokens: list[str], owner_username: str | None) -> tuple[str, list[str]]:
    """Токены адресатов (`@handle`, `@all`) → (строка `@a @b`, реально упомянутые логины).

    `@all` → `@<owner_username>` (заказчик карточки); если владельца нет — токен остаётся `@all`
    (вызывающий предупреждает, сервер его не резолвит). Дубликаты после раскрытия убираются
    (без учёта регистра, порядок сохраняется). Пустой вход → `("", [])`. Чистая функция.
    """
    handles: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        handle = f"@{owner_username}" if (token.lower() == "@all" and owner_username) else token
        if handle.lower() not in seen:
            seen.add(handle.lower())
            handles.append(handle)
    line = " ".join(handles)
    mentioned = [h[1:] for h in handles if h.lower() != "@all"]
    return line, mentioned


def prepend_recipients(text: str, recipients_line: str) -> str:
    """Строку адресатов — в начало ОТДЕЛЬНОЙ строкой; ниже (если есть) текст через пустую строку.

    Пустая строка адресатов → текст без изменений. Пустой текст → только строка адресатов.
    Чистая функция.
    """
    if not recipients_line:
        return text
    return f"{recipients_line}\n\n{text}" if text.strip() else recipients_line


def plan_field_actions(
    current: dict[str, str | None], provided: dict[str, str | None], *, force: bool
) -> tuple[list[tuple[str, str]], list[str]]:
    """Какие обязательные поля писать при закрытии. Чистая функция.

    `current` — текущее значение поля на карточке по kind; `provided` — переданный текст по kind
    (None = не передан). Пишем переданное поле, если на карточке оно пусто ИЛИ `force`; иначе
    пропускаем (вручную/ранее заполненные не перезатираем). Возврат: (`[(kind, value)]` к записи,
    `[kind]` пропущенных как уже заполненные).
    """
    to_set: list[tuple[str, str]] = []
    skipped: list[str] = []
    for kind, value in provided.items():
        if value is None:
            continue
        cur = current.get(kind)
        if force or not (cur and cur.strip()):
            to_set.append((kind, value))
        else:
            skipped.append(kind)
    return to_set, skipped


@app.command("comment")
def comment(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    message: Annotated[
        str | None, typer.Option("--message", "-m", help="Текст комментария (markdown)")
    ] = None,
    body_file: Annotated[
        str | None, typer.Option("--body-file", "-F", help="Файл с телом; `-` — stdin")
    ] = None,
    files: Annotated[
        list[str] | None,
        typer.Option(
            "--file",
            "-f",
            help="Файл-вложение (САМ файл, не его текст); повторяй -f для нескольких файлов",
        ),
    ] = None,
    to: Annotated[
        list[str] | None,
        typer.Option(
            "--to",
            help="Адресат(ы): @all (→ заказчик) и/или @username; в начало отдельной строкой. "
            'Повторяй --to или передай несколько через пробел в кавычках ("@all @ivan")',
        ),
    ] = None,
) -> None:
    """Добавить комментарий к карточке от своего имени (автор — владелец KITEN_API_KEY).

    Текст — `-m TEXT` или `-F PATH` (`-` — stdin). Вложения — `-f PATH` (повторяемо): сами
    файлы прикрепляются к комментарию (не их содержимое в текст). С вложениями/адресатами
    текст необязателен — можно прислать один комментарий из текста, файлов и упоминаний сразу.

    Адресаты — `--to @all @username …` (повторяемо или через пробел в кавычках): пишутся
    самой первой ОТДЕЛЬНОЙ строкой, затем пустая строка и текст. `@all` в `--to` и в самом
    тексте разворачивается в `@username` ВЛАДЕЛЬЦА карточки (заказчик — кому отвечаем):
    в Kaiten нет литерального `@all`, это алиас → `@<username владельца>` (берётся из `owner`
    карточки); упоминание = plain-текст `@логин`, сервер уведомляет.
    """
    card_id = _parse_card_ref(selector)
    attachments = read_attachments(files) if files else []
    recipients = parse_recipients(to or [])
    text = resolve_comment_text(
        message,
        body_file,
        stdin_read=sys.stdin.read,
        require_text=not (attachments or recipients),
    )
    client = KaitenClient.from_env()
    mentioned: list[str] = []
    try:
        # Владелец нужен, если есть `--to` или `@all` в тексте — берём карточку один раз.
        need_owner = bool(recipients) or bool(ALL_MENTION_RE.search(text))
        card = client.get_card(card_id) if need_owner else None
        owner_username = card.owner.username if (card and card.owner) else None
        no_owner = need_owner and not owner_username
        if no_owner:
            typer.echo(
                f"{COMMAND_NAME} comment: у карточки нет владельца с username — "
                "оставляю '@all' как есть",
                err=True,
            )
        if card is not None and ALL_MENTION_RE.search(text):
            text, in_text = _expand_all_to_owner(text, card)
            mentioned.extend(in_text)
        if recipients:
            line, to_mentioned = expand_recipients(recipients, owner_username)
            text = prepend_recipients(text, line)
            mentioned.extend(to_mentioned)
        created = client.add_comment(card_id, text, files=attachments or None)
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} comment: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None
    typer.echo(f"ok: комментарий {created.id} → {card_url(client.base_url, card_id)}")
    if attachments:
        typer.echo(f"   вложения: {', '.join(name for name, _ in attachments)}")
    if mentioned:
        unique = list(dict.fromkeys(mentioned))
        typer.echo(f"   адресаты: {' '.join('@' + h for h in unique)}")


@app.command("move")
def move(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    lane: Annotated[
        str | None,
        typer.Option(
            "--lane",
            help="Дорожка назначения: ID или подстрока названия (см. `mpu kiten lanes`)",
            autocompletion=_complete_lane,
        ),
    ] = None,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Колонка назначения: ID или подстрока названия (см. `mpu kiten columns`)",
            autocompletion=_complete_column,
        ),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board",
            help="Доска назначения: ID/подстрока (перенос на другую доску; `mpu kiten boards`)",
            autocompletion=_complete_board,
        ),
    ] = None,
) -> None:
    """Переместить карточку: по дорожке (`--lane`), колонке (`--column`) и/или доске (`--board`).

    Нужна хотя бы одна ось. Подстроки `--lane`/`--column` резолвятся в скоупе целевой доски
    (`--board`, иначе текущая доска карточки), чтобы одноимённые дорожки/колонки разных досок
    не путались.
    """
    if lane is None and column is None and board is None:
        raise typer.BadParameter("нужно хотя бы одно из --lane / --column / --board")
    card_id = _parse_card_ref(selector)
    cli_board = _resolve_board(board)
    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
        # Скоуп резолва дорожки/колонки — целевая доска: явный --board, иначе текущая карточки.
        scope_board = cli_board if cli_board is not None else before.board_id
        lane_id = _resolve_lane(lane, scope_board)
        column_id = _resolve_column(column, scope_board)
        # Перевод только по колонке, и карточка уже в ней → релог-bump (влево→обратно),
        # чтобы Kaiten записал перемещение (в ту же колонку он его игнорирует).
        relogged = (
            lane_id is None
            and cli_board is None
            and column_id is not None
            and before.column_id == column_id
        )
        if relogged and column_id is not None:
            neighbor_id = _left_neighbor_column(client, before.board_id, column_id)
            client.move_card(card_id, column_id=neighbor_id)
            client.move_card(card_id, column_id=column_id)
        else:
            client.move_card(card_id, lane_id=lane_id, column_id=column_id, board_id=cli_board)
        # PATCH-ответ Kaiten не несёт title'ов колонки/доски/дорожки (только id) → свежий GET.
        after = client.get_card(card_id)
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} move: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None
    _record_card_move(card_id, before, after)
    suffix = " (релог)" if relogged else ""
    typer.echo(f"ok: {_location_label(before)} → {_location_label(after)}{suffix} · {after.url}")


def _location_label(detail: KaitenCardDetail) -> str:
    """`Доска · Колонка · Дорожка` карточки (непустые части); пусто → «—»."""
    parts = (detail.board_title, detail.column_title, detail.lane_title)
    return " · ".join(x for x in parts if x) or "—"


def _record_card_move(
    card_id: int, before: KaitenCardDetail, after: KaitenCardDetail, *, note: str | None = None
) -> None:
    """Записать перемещение в локальный журнал `kaiten_card_moves` (для `mpu telegram status`)."""
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_move(
            conn,
            card_id,
            to_column=after.column_title or "—",
            title=after.title,
            url=after.url,
            from_column=before.column_title,
            lane=after.lane_title,
            board=after.board_title,
            note=note,
        )


def _left_neighbor_column(client: KaitenClient, board_id: int | None, target_id: int) -> int:
    """Колонка слева от `target_id` (по `sort_order`); если цель крайняя левая — берём правую
    соседку. Нужна для релог-bump: перевести карточку в соседнюю колонку и обратно."""
    cols = client.list_columns([board_id] if board_id is not None else [])
    if not cols:
        raise typer.BadParameter("не удалось получить колонки доски для релога")
    ordered = sorted(cols, key=lambda c: (c.sort_order if c.sort_order is not None else 0.0, c.id))
    ids = [c.id for c in ordered]
    if target_id not in ids:
        raise typer.BadParameter("целевая колонка не найдена на доске карточки")
    i = ids.index(target_id)
    if i > 0:
        return ids[i - 1]
    if len(ids) > 1:
        return ids[i + 1]
    raise typer.BadParameter("на доске одна колонка — релог невозможен")


def _move_to_target_column(
    selector: str, target_name: str, *, note: str | None, dry_run: bool
) -> None:
    """Перевести карточку в колонку `target_name` (точное имя в приоритете) на её текущей доске;
    дорожка/доска сохраняются. Если карточка уже в целевой колонке — релог-bump (влево→обратно),
    чтобы Kaiten зафиксировал перемещение как моё сегодня. Логирует в `kaiten_card_moves`."""
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME}: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None
    target_id = _resolve_column(target_name, before.board_id)
    if target_id is None:  # target_name не None → вернётся int либо BadParameter; защита для типов
        raise typer.BadParameter(f"колонка «{target_name}» не найдена")
    already = before.column_id == target_id
    if dry_run:
        action = "релог (влево→обратно)" if already else "перемещение"
        typer.echo(
            f"dry-run: {action} → «{target_name}» (колонка {target_id}); "
            f"сейчас {_location_label(before)}; PATCH не отправлен"
        )
        return
    try:
        if already:
            neighbor_id = _left_neighbor_column(client, before.board_id, target_id)
            client.move_card(card_id, column_id=neighbor_id)
        client.move_card(card_id, column_id=target_id)
        # PATCH-ответ Kaiten не несёт title'ов колонки/доски (только id) → свежий GET.
        after = client.get_card(card_id)
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME}: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None
    _record_card_move(card_id, before, after, note=note)
    suffix = " (релог)" if already else ""
    typer.echo(f"ok: {_location_label(before)} → {_location_label(after)}{suffix} · {after.url}")


@app.command("ready")
def ready(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Целевая колонка (ID/имя); по умолчанию env KITEN_READY_COLUMN или «Готово»",
            autocompletion=_complete_column,
        ),
    ] = None,
    note: Annotated[
        str | None, typer.Option("--note", help="Заметка, сохраняется в журнал перемещений")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное действие без PATCH и без лога")
    ] = False,
) -> None:
    """Перевести карточку в колонку «Готово» (дорожка/доска сохраняются) + лог в журнал.

    Цель — точное имя колонки на текущей доске карточки (env `KITEN_READY_COLUMN`, по
    умолчанию «Готово»; переопределяется `--column`). Если карточка уже в этой колонке —
    делается релог-bump (перевод в соседнюю колонку и обратно), т.к. перевод в ту же колонку
    Kaiten не логирует.
    """
    target = column or env.get("KITEN_READY_COLUMN") or "Готово"
    _move_to_target_column(selector, target, note=note, dry_run=dry_run)


@app.command("review")
def review(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Целевая колонка (ID/имя); по умолчанию env KITEN_REVIEW_COLUMN или «Код-ревью»",
            autocompletion=_complete_column,
        ),
    ] = None,
    note: Annotated[
        str | None, typer.Option("--note", help="Заметка, сохраняется в журнал перемещений")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное действие без PATCH и без лога")
    ] = False,
) -> None:
    """Перевести карточку в колонку ревью (дорожка/доска сохраняются) + лог в журнал.

    Цель — точное имя колонки на текущей доске (env `KITEN_REVIEW_COLUMN`, по умолчанию
    «Код-ревью»; переопределяется `--column`). Если карточку уже двинул в ревью кто-то другой —
    делается релог-bump (соседняя колонка и обратно), чтобы Kaiten записал это как моё
    перемещение сегодня (перевод в ту же колонку Kaiten не логирует).
    """
    target = column or env.get("KITEN_REVIEW_COLUMN") or "Код-ревью"
    _move_to_target_column(selector, target, note=note, dry_run=dry_run)


@app.command("close")
def close(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    hypothesis: Annotated[
        str | None, typer.Option("--hypothesis", help="«Причина/гипотеза» (если поле пусто)")
    ] = None,
    done: Annotated[str | None, typer.Option("--done", help="«Что сделано» (если пусто)")] = None,
    result: Annotated[str | None, typer.Option("--result", help="«Результат» (если пусто)")] = None,
    mr: Annotated[str | None, typer.Option("--mr", help="Ссылка на MR (если поле пусто)")] = None,
    reply: Annotated[
        str | None, typer.Option("--reply", help="Ответ клиенту (markdown; `@all`→владелец)")
    ] = None,
    reply_file: Annotated[
        str | None, typer.Option("--reply-file", help="Файл с телом ответа; `-` — stdin")
    ] = None,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Колонка переноса (по умолч. KITEN_READY_COLUMN или «Готово»)",
            autocompletion=_complete_column,
        ),
    ] = None,
    force_fields: Annotated[
        bool, typer.Option("--force-fields", help="Перезаписать поля, даже если заполнены")
    ] = False,
    no_move: Annotated[
        bool, typer.Option("--no-move", help="Не переносить карточку (только поля/ответ)")
    ] = False,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Показать план без записей")] = False,
) -> None:
    """Закрыть карточку: пустые обязательные поля + (опц.) ответ клиенту + перенос в «Готово».

    Детерминированный оркестратор: тексты полей/ответа готовит вызывающий, передаёт аргументами.
    Поля пишутся только если на карточке пусты (вручную/ранее заполненные пропускаются;
    `--force-fields` перезаписывает). `@all` в ответе → `@username` владельца (заказчик). Перенос —
    с релогом, если уже в колонке. Порядок: поля → ответ → перенос. `--dry-run` — только план.
    """
    card_id = _parse_card_ref(selector)
    if reply is not None and reply_file is not None:
        raise typer.BadParameter("--reply и --reply-file взаимоисключающи")
    reply_text: str | None = reply
    if reply_file == "-":
        reply_text = sys.stdin.read()
    elif reply_file is not None:
        try:
            reply_text = Path(reply_file).read_text(encoding="utf-8")
        except OSError as e:
            raise typer.BadParameter(f"не удалось прочитать {reply_file}: {e}") from None
    if reply_text is not None and not reply_text.strip():
        raise typer.BadParameter("пустой текст ответа")

    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
    except KaitenAPIError as e:
        typer.echo(f"{COMMAND_NAME} close: kaiten error: {e}", err=True)
        raise typer.Exit(code=1) from None

    provided = {"hypothesis": hypothesis, "done": done, "result": result, "mr": mr}
    current = {k: before.properties.get(kaiten_links.property_key(k)) for k in provided}
    to_set, skipped = plan_field_actions(current, provided, force=force_fields)

    mentioned: list[str] = []
    if reply_text is not None:
        had_all = ALL_MENTION_RE.search(reply_text) is not None
        reply_text, mentioned = _expand_all_to_owner(reply_text, before)
        if had_all and not mentioned:
            typer.echo(
                f"{COMMAND_NAME} close: у карточки нет владельца — '@all' оставлен как есть",
                err=True,
            )

    target = column or env.get("KITEN_READY_COLUMN") or "Готово"
    set_lbl = ", ".join(k for k, _ in to_set) or "—"
    skip_lbl = f"; пропущены (заполнены) [{', '.join(skipped)}]" if skipped else ""
    men_lbl = f" (@all → {' '.join('@' + h for h in mentioned)})" if mentioned else ""

    if dry_run:
        typer.echo(f"dry-run close · {before.url}")
        typer.echo(f"  поля: записать [{set_lbl}]{skip_lbl}")
        typer.echo(f"  ответ: {'запостить' + men_lbl if reply_text is not None else 'без ответа'}")
        if no_move:
            typer.echo("  перенос: пропущен (--no-move)")
        else:
            _move_to_target_column(selector, target, note=None, dry_run=True)
        return

    if to_set:
        with store.store() as conn:
            store.bootstrap(conn)
            try:
                for kind, value in to_set:
                    kaiten_links.record_link(conn, card_id, kind, value)
                    _sync_card_field(conn, client, card_id, kind)
            except KaitenAPIError as e:
                typer.echo(f"{COMMAND_NAME} close: kaiten error (поля): {e}", err=True)
                raise typer.Exit(code=1) from None
    reply_comment_id: int | None = None
    if reply_text is not None:
        try:
            reply_comment_id = client.add_comment(card_id, reply_text).id
        except KaitenAPIError as e:
            typer.echo(f"{COMMAND_NAME} close: kaiten error (ответ): {e}", err=True)
            raise typer.Exit(code=1) from None
    typer.echo(f"ok close: поля [{set_lbl}]{skip_lbl}")
    if reply_comment_id is not None:
        typer.echo(f"   ответ: комментарий {reply_comment_id}{men_lbl}")
    if not no_move:
        _move_to_target_column(selector, target, note=None, dry_run=False)


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


def _load_column_map() -> dict[str, str]:
    """Маппинг для `{column_mapped}` из .env `KITEN_COLUMN_MAP` (JSON: id-ИЛИ-имя → метка).

    Пусто/некорректный JSON → `{}` (с предупреждением в stderr), `{column_mapped}` тогда
    равен исходному имени колонки. Ключи нормализуются в строки (id или название колонки).
    """
    raw = env.get("KITEN_COLUMN_MAP")
    if not raw or not raw.strip():
        return {}
    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as e:
        typer.echo(f"{COMMAND_NAME} ls: некорректный JSON в KITEN_COLUMN_MAP: {e}", err=True)
        return {}
    if not isinstance(data, dict):
        typer.echo(f"{COMMAND_NAME} ls: KITEN_COLUMN_MAP должен быть JSON-объектом", err=True)
        return {}
    data_dict = cast("dict[str, object]", data)
    return {str(k): str(v) for k, v in data_dict.items()}


def _format_card(
    template: str, n: int, card: KaitenCard, col_names: dict[int, str], col_map: dict[str, str]
) -> str:
    """Подставить плейсхолдеры шаблона для карточки (через replace — безопасно к `{` в данных)."""
    raw_col = _column_cell(card, col_names)
    if card.column_id is not None and str(card.column_id) in col_map:
        mapped_col = col_map[str(card.column_id)]
    else:
        mapped_col = col_map.get(raw_col, raw_col)
    values = {
        "n": str(n),
        "id": str(card.id),
        "title": card.title,
        "url": card.url,
        "state": state_label(card.state),
        "due": (card.due_date or "")[:10],
        "column": raw_col,
        "column_mapped": mapped_col,
    }
    out = template
    for key, val in values.items():
        out = out.replace("{" + key + "}", val)
    return out


def _md_link_text(text: str) -> str:
    """Экранировать `[` и `]` в тексте markdown-ссылки `[текст](url)`."""
    return text.replace("[", "\\[").replace("]", "\\]")


def _md_cell(text: str) -> str:
    """Ячейка GFM-таблицы: экранировать `|` и убрать переводы строк."""
    return text.replace("|", "\\|").replace("\n", " ")


def _cards_to_md_table(cards: list[KaitenCard], col_names: dict[int, str]) -> str:
    """Карточки → GFM-таблица (те же колонки, что и rich-вывод `_print_cards`)."""
    headers = [header for header, _extract in _COLUMNS]
    rows = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for c in cards:
        cells = [_md_cell(extract(c, col_names)) for _header, extract in _COLUMNS]
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join(rows)


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


def _card_detail_dict(detail: KaitenCardDetail, comments: list[KaitenComment]) -> dict[str, object]:
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


# --- field: кастомные поля карточки (MR-ссылка / гипотеза / что сделано / результат) ---
#
# `set`/`update`/`rm` — мутирующие (PATCH /cards + запись в SQLite-лог); `ls` — read-only
# (только лог). Поле карточки всегда = последняя по времени запись лога для (card, field);
# история (несколько MR на карточку) живёт в `kaiten_card_links`.


class FieldKind(StrEnum):
    mr = "mr"
    hypothesis = "hypothesis"
    done = "done"
    result = "result"


field_app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Кастомные поля карточки + лог в SQLite: `set` — записать значение в поле "
        "(mr/hypothesis/done/result) и в историю; `ls` — история (read-only); "
        "`update`/`rm` — правка/удаление записи лога. Несколько записей на карточку "
        "(напр. несколько MR); поле карточки = последняя по времени запись."
    ),
)
app.add_typer(field_app, name="field")


def _sync_card_field(
    conn: sqlite3.Connection, client: KaitenClient, card_id: int, field: str
) -> str | None:
    """Поле карточки := последняя запись лога (или очистка). Возвращает применённое значение."""
    value = kaiten_links.latest_value(conn, card_id, field)
    client.set_card_property(card_id, kaiten_links.property_key(field), value)
    return value


@field_app.command("set")
def field_set(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    kind: Annotated[FieldKind, typer.Argument(help="Поле: mr / hypothesis / done / result")],
    value: Annotated[str, typer.Argument(help="Значение (для mr — URL мерж-реквеста)")],
) -> None:
    """Записать значение в кастомное поле карточки и добавить запись в историю (лог).

    Поле карточки становится этим значением (последняя запись лога). Для `mr` можно
    вызывать несколько раз — каждый запуск добавляет MR в историю; в поле карточки
    «Ссылка на Merge Request» остаётся последний.
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_link(conn, card_id, kind.value, value)
        try:
            applied = _sync_card_field(conn, client, card_id, kind.value)
        except KaitenAPIError as e:
            typer.echo(f"{COMMAND_NAME} field set: kaiten error: {e}", err=True)
            raise typer.Exit(code=1) from None
    typer.echo(f"ok: {kind.value} → {applied} · {card_url(client.base_url, card_id)}")


@field_app.command("ls")
def field_ls(
    card: Annotated[
        str | None,
        typer.Option("--card", help="Фильтр по карточке (ID или URL)"),
    ] = None,
    kind: Annotated[
        FieldKind | None,
        typer.Option("--kind", help="Фильтр по полю: mr / hypothesis / done / result"),
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """История привязок (read-only): id, карточка, поле, значение, время."""
    card_id: int | None = None
    if card is not None:
        card_id = _parse_card_ref(card)
    with store.store() as conn:
        store.bootstrap(conn)
        links = kaiten_links.list_links(
            conn, card_id=card_id, field=None if kind is None else kind.value
        )
    if out_json:
        payload = [
            {
                "id": link.id,
                "card_id": link.card_id,
                "field": link.field,
                "value": link.value,
                "created_at": link.created_at,
            }
            for link in links
        ]
        typer.echo(_json.dumps(payload, ensure_ascii=False))
        return
    if not links:
        typer.echo("(пусто)")
        return
    table = Table(box=None)
    for col in ("id", "card", "field", "when", "value"):
        table.add_column(col)
    for link in links:
        when = datetime.datetime.fromtimestamp(link.created_at, tz=datetime.UTC).strftime(
            "%Y-%m-%d %H:%M"
        )
        table.add_row(str(link.id), str(link.card_id), link.field, when, link.value)
    Console().print(table)


@field_app.command("update")
def field_update(
    record_id: Annotated[int, typer.Argument(help="ID записи лога (см. `mpu kiten field ls`)")],
    value: Annotated[str, typer.Argument(help="Новое значение")],
) -> None:
    """Изменить значение записи лога и пере-синхронизировать поле карточки."""
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        link = kaiten_links.update_link(conn, record_id, value)
        if link is None:
            typer.echo(f"{COMMAND_NAME} field update: записи #{record_id} нет", err=True)
            raise typer.Exit(code=1)
        try:
            applied = _sync_card_field(conn, client, link.card_id, link.field)
        except KaitenAPIError as e:
            typer.echo(f"{COMMAND_NAME} field update: kaiten error: {e}", err=True)
            raise typer.Exit(code=1) from None
    url = card_url(client.base_url, link.card_id)
    typer.echo(f"ok: #{record_id} {link.field} → {applied} · {url}")


@field_app.command("rm")
def field_rm(
    record_id: Annotated[int, typer.Argument(help="ID записи лога (см. `mpu kiten field ls`)")],
) -> None:
    """Удалить запись лога и пере-синхронизировать поле карточки (на предыдущую запись/очистку)."""
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        link = kaiten_links.delete_link(conn, record_id)
        if link is None:
            typer.echo(f"{COMMAND_NAME} field rm: записи #{record_id} нет", err=True)
            raise typer.Exit(code=1)
        try:
            applied = _sync_card_field(conn, client, link.card_id, link.field)
        except KaitenAPIError as e:
            typer.echo(f"{COMMAND_NAME} field rm: kaiten error: {e}", err=True)
            raise typer.Exit(code=1) from None
    tail = "(очищено)" if applied is None else f"→ {applied}"
    url = card_url(client.base_url, link.card_id)
    typer.echo(f"ok: удалена #{record_id} {link.field} {tail} · {url}")
