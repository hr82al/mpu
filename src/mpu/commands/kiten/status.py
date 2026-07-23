"""`mpu kiten status` — вся моя работа в Kaiten одной таблицей-матрицей.

Три источника «моего» (карточки разбросаны по десятку досок, ни один источник не полон):

- **назначено** — `GET /cards?member_ids=<я>` и `?responsible_id=<я>`: сюда попадает и
  «назначена, но ещё не тронута»;
- **моё время** — `GET /users/<я>/time-logs?from=&to=`: единственный способ увидеть
  карточки, где я работал, НЕ будучи участником (ревью, чужая поддержка);
- **мои действия** — `GET /users/current/activities`: комментарии и перемещения.

Слои: `_status_data.py` — этапы, строки, сбор и фильтры; `_status_render.py` — раскладка
и печать; здесь — только опции и оркестрация.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated

import typer
from rich.console import Console

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, _complete_board, _resolve_board
from mpu.commands.kiten._status_data import (
    SRC_ACTIVITY,
    SRC_ASSIGNED,
    SRC_TIME,
    SRC_TOUCH,
    STAGE_ALIASES,
    Collected,
    RowFilters,
    StatusRow,
    Window,
    apply_filters,
    collect,
    fill_stages,
    iso_utc,
    resolve_stage_filter,
    sort_rows,
)
from mpu.commands.kiten._status_render import (
    print_json_rows,
    print_template_rows,
    print_url_rows,
    render_footer,
    render_groups,
    render_matrix,
    rows_to_md_table,
)
from mpu.lib.cli_err import die
from mpu.lib.duration import DurationParseError, parse_since
from mpu.lib.kaiten import KaitenAPIError, KaitenClient

DEFAULT_SINCE = "7d"
DEFAULT_TIME_SINCE = "365d"
# Лента активностей не фильтруется по дате на сервере — глубина берётся страницами по 100.
# Шире окно → больше страниц; потолок бережёт от долгого обхода на «--since 365d».
PAGES_PER_WEEK = 3
MAX_ACTIVITY_PAGES = 12
SECONDS_IN_WEEK = 7 * 24 * 3600


class Out(StrEnum):
    """Форма вывода — одна ось вместо россыпи взаимоисключающих флагов."""

    matrix = "matrix"
    group = "group"
    json = "json"
    md = "md"
    url = "url"


class Only(StrEnum):
    """Срез по завершённости."""

    open = "open"
    done = "done"


class Source(StrEnum):
    """Почему карточка в списке; `touch` — карточка чужая, я её лишь коснулся."""

    assigned = SRC_ASSIGNED
    time = SRC_TIME
    activity = SRC_ACTIVITY
    touch = SRC_TOUCH


def activity_pages(since_ts: int, now_ts: int) -> int:
    """Сколько страниц ленты читать под окно `--since` (у неё нет фильтра по дате)."""
    weeks = max(1, round((now_ts - since_ts) / SECONDS_IN_WEEK))
    return min(MAX_ACTIVITY_PAGES, weeks * PAGES_PER_WEEK)


def build_window(since: str, time_since: str) -> Window:
    """Опции окна → границы сбора; ошибку формата печатаем с именем виноватой опции."""
    try:
        since_ts = parse_since(since)
    except DurationParseError as e:
        die(f"{COMMAND_NAME} status: --since: {e}")
    try:
        time_ts = parse_since(time_since)
    except DurationParseError as e:
        die(f"{COMMAND_NAME} status: --time-since: {e}")
    since_iso = iso_utc(since_ts)
    now_ts = int(datetime.now(tz=UTC).timestamp())
    return Window(
        since_day=since_iso[:10],
        since_iso=since_iso,
        time_from_iso=iso_utc(time_ts),
        max_pages=activity_pages(since_ts, now_ts),
    )


def emit(
    rows: list[StatusRow], collected: Collected, *, out: Out, window: Window, since: str
) -> None:
    """Напечатать выдачу в выбранной форме (машинные форматы — без подвала и рамок)."""
    today = datetime.now(tz=UTC).strftime("%Y-%m-%d")
    if out is Out.json:
        print_json_rows(rows)
        return
    if out is Out.url:
        print_url_rows(rows)
        return
    if out is Out.md:
        typer.echo(rows_to_md_table(rows, today))
        return
    if not rows:
        typer.echo("(нет карточек)")
        return
    console = Console()
    if out is Out.group:
        render_groups(rows, console=console, today=today, link=True)
    else:
        render_matrix(rows, console=console, today=today, link=True)
    render_footer(rows, collected, console=console, since_day=window.since_day, since=since)
    warn_activity_reach(collected, window)


def warn_activity_reach(collected: Collected, window: Window) -> None:
    """Лента действий могла оборваться на лимите страниц — молчать об этом нельзя:
    выдача выглядела бы полной за окно, хотя часть карточек в неё не попала."""
    reach = collected.activity_reach
    if reach and reach > window.since_iso:
        typer.echo(
            f"{COMMAND_NAME} status: лента действий прочитана только до {reach[:10]} "
            f"(предел {window.max_pages} страниц); карточки, которые я лишь комментировал "
            f"раньше этой даты, могли не попасть в выдачу",
            err=True,
        )


@app.command("status")
def status(
    since: Annotated[
        str,
        typer.Option(
            "--since", help=f"Окно активности: 7d / 12h / unix-ts. Дефолт {DEFAULT_SINCE}"
        ),
    ] = DEFAULT_SINCE,
    out: Annotated[
        Out,
        typer.Option("--out", help="Форма вывода: matrix|group|json|md|url"),
    ] = Out.matrix,
    stage: Annotated[
        str | None,
        typer.Option("--stage", help=f"Только этап: {'|'.join(STAGE_ALIASES)}"),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board", help="Доска: ID или подстрока названия", autocompletion=_complete_board
        ),
    ] = None,
    source: Annotated[
        Source | None,
        typer.Option(
            "--source",
            help="Почему карточка в списке: assigned|time|activity; "
            "touch — только касание (не назначена и время не списывал)",
        ),
    ] = None,
    only: Annotated[
        Only | None,
        typer.Option("--only", help="Срез: open (незавершённые) | done (завершённые)"),
    ] = None,
    out_format: Annotated[
        str | None,
        typer.Option(
            "--format",
            help="Шаблон строки: {n} {id} {title} {url} {stage} {board} {lane} {due} {min} {src}",
        ),
    ] = None,
    time_since: Annotated[
        str,
        typer.Option(
            "--time-since",
            help=f"Окно суммы в колонке ВРЕМЯ. Дефолт {DEFAULT_TIME_SINCE}; сузить — быстрее",
        ),
    ] = DEFAULT_TIME_SINCE,
) -> None:
    """Вся моя работа в Kaiten: назначенное + где списывал время + где что-то делал.

    Одна матрица по всем доскам: строка — карточка, столбцы — этапы (печатаются только
    непустые), `●` — текущий этап. Колонка ИСТ отвечает, почему карточка здесь:
    👤 назначена · 🕒 списывал время · 📝 комментировал/двигал — второе и третье как раз
    ловят карточки, где я не участник (ревью, чужая поддержка).

    Колонка ВРЕМЯ — всё МОЁ время по карточке за `--time-since` (не только за окно).
    Живые (не архивные) карточки показываются независимо от `--since`.

    Примеры:
      mpu kiten status                      # матрица за 7 дней
      mpu kiten status --only open          # только незавершённое
      mpu kiten status --out group          # секции по этапам
      mpu kiten status --source time        # где работал, не будучи участником
      mpu kiten status --out json
    """
    stage_label = None
    if stage is not None:
        stage_label = resolve_stage_filter(stage)
        if stage_label is None:
            die(
                f"{COMMAND_NAME} status: неизвестный этап {stage!r}; "
                f"допустимо: {', '.join(STAGE_ALIASES)}"
            )
    window = build_window(since, time_since)

    client = KaitenClient.from_env()
    try:
        me = client.current_user()
        collected = collect(client, me_id=me.id, window=window)
        fill_stages(collected.rows)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} status: kaiten error: {e}")

    filters = RowFilters(
        stage=stage_label,
        board_id=_resolve_board(board),
        source=source.value if source is not None else None,
        only_open=only is Only.open,
        only_done=only is Only.done,
    )
    rows = sort_rows(apply_filters(collected.rows, filters))
    if out_format is not None:
        print_template_rows(rows, out_format)
        return
    emit(rows, collected, out=out, window=window, since=since)
