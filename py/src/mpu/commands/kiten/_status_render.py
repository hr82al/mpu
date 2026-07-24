"""`mpu kiten status` — вывод: раскладка под ширину терминала, матрица, группы, форматы.

Данные сюда приходят готовыми (`_status_data.py`), опции — уже разобранными (`status.py`).
Вся арифметика ширины считается в терминальных ЯЧЕЙКАХ (`rich.cells.cell_len`): emoji
занимает две, и подсчёт по `len` разъезжает колонки.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import typer
from rich import box
from rich.cells import cell_len
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from mpu.commands.kiten._render import _md_cell, _md_link_text
from mpu.commands.kiten._status_data import (
    Collected,
    Stage,
    StatusRow,
    is_touch_only,
    present_stages,
    source_marks,
    summarise_minutes,
)
from mpu.lib.cli_out import print_json
from mpu.lib.kaiten import state_label
from mpu.lib.table_fit import fit_text, free_budget, pad_to

MIN_TITLE = 24  # ниже этого заголовок карточки нечитаем — начинаем ужимать остальное
LANE_WIDTH = 14
MINUTES_WIDTH = 6
DATE_WIDTH = 7
SRC_WIDTH = 6
LETTERS_LEVEL = 2  # уровень подписей «одна буква» — под таблицей печатается легенда
MINUTES_IN_HOUR = 60
GROUP_INDENT = 3
GROUP_LANE_WIDTH = 22
GROUP_TITLE_WIDTH = 48
MIN_GROUP_TITLE = 12  # уже нечитаемо, но лучше огрызка заголовка, чем разрыв строки


# ── Ячейки ──────────────────────────────────────────────────────────────────────


def format_minutes(minutes: int) -> str:
    """Минуты → `5ч17м` / `45м`; 0 → `—` (времени не списывал)."""
    if minutes <= 0:
        return "—"
    hours, rest = divmod(minutes, MINUTES_IN_HOUR)
    return f"{hours}ч{rest:02d}м" if hours else f"{rest}м"


# Границы русского счётного правила: 11–14 — всегда «карточек», иначе решает последняя цифра.
TEEN_RANGE = range(11, 15)
FEW_RANGE = range(2, 5)


def plural_cards(count: int) -> str:
    """Русское склонение слова «карточка» по числу: 1 карточка, 3 карточки, 25 карточек."""
    if count % 100 in TEEN_RANGE:
        return "карточек"
    tail = count % 10
    if tail == 1:
        return "карточка"
    if tail in FEW_RANGE:
        return "карточки"
    return "карточек"


def short_date(iso: str | None, today: str) -> str:
    """`2026-07-23…` → `сегодня` / `вчера` / `07.21`; пусто → `—`."""
    day = (iso or "")[:10]
    if not day:
        return "—"
    if day == today:
        return "сегодня"
    yesterday = (datetime.fromisoformat(today) - timedelta(days=1)).strftime("%Y-%m-%d")
    if day == yesterday:
        return "вчера"
    return day[5:].replace("-", ".")


def lane_cell(row: StatusRow) -> str:
    """Подпись места: дорожка, иначе пространство, иначе доска.

    Пространство раньше доски намеренно: у support-карточек дорожек нет, а доска у них
    называется «Не использовать для новых карточек!» — в таблице это бесполезный шум,
    тогда как «10Х Support» сразу говорит, откуда карточка.
    """
    return row.card.lane_title or row.card.space_title or row.card.board_title or ""


def id_cell(row: StatusRow, *, link: bool) -> str:
    """ID карточки; с гиперссылкой — кликабелен в терминале (OSC-8)."""
    marker = "🔥" if row.escalated else ""
    text = f"{marker}{row.card.id}"
    return f"[link={row.card.url}]{text}[/link]" if link and row.card.url else text


# ── Раскладка под ширину терминала ──────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Layout:
    """Что и в какой ширине печатать при текущем размере терминала."""

    headers: list[str]
    show_lane: bool
    title_budget: int
    legend: str


def plan_layout(console_width: int, stages: list[Stage], id_width: int) -> Layout:
    """Подобрать раскладку: TITLE → заголовки этапов (полные→3 буквы→1) → дорожка.

    Порядок жертв: заголовок карточки ужимается всегда (`title_budget`), затем подписи
    этапов, и только когда все варианты С дорожкой исчерпаны — она убирается. Поэтому
    дорожка во внешнем цикле, а уровень подписей — во внутреннем.

    Минимальная ширина колонки этапа — 1 ячейка (отметка `●`), иначе ступень «3 буквы»
    не отличалась бы по ширине от ступени «1 буква» и была бы бесполезной.
    """
    variants = [(show_lane, level) for show_lane in (True, False) for level in (0, 1, 2)]
    for show_lane, level in variants:
        headers = [(stage.label, stage.short, stage.letter)[level] for stage in stages]
        fixed = [id_width, *(max(cell_len(h), 1) for h in headers)]
        fixed += [MINUTES_WIDTH, DATE_WIDTH, SRC_WIDTH]
        if show_lane:
            fixed.append(LANE_WIDTH)
        budget = free_budget(console_width, fixed, len(fixed) + 1)
        if budget >= MIN_TITLE or (show_lane, level) == variants[-1]:
            legend = ""
            if level == LETTERS_LEVEL:
                legend = " · ".join(f"{stage.letter}={stage.label}" for stage in stages)
            return Layout(headers, show_lane, budget, legend)
    raise AssertionError("plan_layout: цикл обязан вернуть раскладку на последнем варианте")


# ── Раскладки вывода ────────────────────────────────────────────────────────────


def render_matrix(rows: list[StatusRow], *, console: Console, today: str, link: bool) -> None:
    """Матрица «карточка × этап»: `●` — текущий этап, пустые этапы не печатаются."""
    stages = present_stages(rows)
    id_width = max([len("ID"), *(cell_len(id_cell(r, link=False)) for r in rows)])
    layout = plan_layout(console.width, stages, id_width)

    table = Table(box=box.SQUARE, header_style="bold", show_lines=False)
    # Вправо: у эскалации перед номером стоит 🔥 (2 ячейки), и при левом выравнивании
    # цифры такой строки уезжали относительно остальных.
    table.add_column("ID", justify="right", no_wrap=True)
    for header in layout.headers:
        table.add_column(header, justify="center", no_wrap=True)
    table.add_column("ВРЕМЯ", justify="right", no_wrap=True)
    table.add_column("ОБНОВЛ", no_wrap=True)
    if layout.show_lane:
        table.add_column("ДОРОЖКА", no_wrap=True, overflow="ellipsis")
    table.add_column("ИСТ", no_wrap=True)
    table.add_column("TITLE", no_wrap=True, overflow="ellipsis")

    for row in rows:
        table.add_row(
            *_matrix_cells(row, stages, layout, today=today, link=link),
            style="dim" if row.closed else None,
        )
    console.print(table)
    if layout.legend:
        console.print(f"[dim]{escape(layout.legend)}[/dim]")


def _matrix_cells(
    row: StatusRow, stages: list[Stage], layout: Layout, *, today: str, link: bool
) -> list[str]:
    marks = ["●" if row.stage == stage.label else "·" for stage in stages]
    cells = [id_cell(row, link=link), *marks, format_minutes(row.my_minutes)]
    cells.append(short_date(row.card.updated, today))
    if layout.show_lane:
        cells.append(escape(fit_text(lane_cell(row), LANE_WIDTH)))
    cells.append(source_marks(row.sources))
    cells.append(escape(fit_text(row.card.title, layout.title_budget)))
    return cells


def render_groups(rows: list[StatusRow], *, console: Console, today: str, link: bool) -> None:
    """Секции по этапам: заголовок этапа и карточки под ним.

    Колонки выравниваются `pad_to` (по терминальным ячейкам), а не `f`-строкой: флаг 🔥
    у эскалации занимает две ячейки и сдвинул бы всю строку.
    """
    id_width = max([1, *(cell_len(id_cell(r, link=False)) for r in rows)])
    title_budget = group_title_budget(console.width, id_width)
    for stage in present_stages(rows):
        group = [r for r in rows if r.stage == stage.label]
        console.print(f"[bold]▸ {escape(stage.label)}[/bold] ({len(group)})")
        for row in group:
            console.print(
                _group_line(row, id_width=id_width, budget=title_budget, today=today, link=link),
                style="dim" if row.closed else None,
            )


def group_title_budget(console_width: int, id_width: int) -> int:
    """Сколько ячеек остаётся заголовку в групповом виде — иначе строка переносится.

    Считается по ФАКТИЧЕСКОЙ ширине консоли: фиксированной величины (48) хватало на
    широком терминале и рвало строку надвое на узком.
    """
    prefix = GROUP_INDENT + id_width + 1 + (MINUTES_WIDTH + 1) + 2 + GROUP_LANE_WIDTH + 1
    prefix += (DATE_WIDTH + 1) + 1 + SRC_WIDTH + 1
    return max(MIN_GROUP_TITLE, min(GROUP_TITLE_WIDTH, console_width - prefix))


def _group_line(row: StatusRow, *, id_width: int, budget: int, today: str, link: bool) -> str:
    # Номер прижат вправо — как в матрице: 🔥 у эскалации иначе сдвигает цифры.
    gap = " " * max(0, id_width - cell_len(id_cell(row, link=False)))
    return (
        f"   {gap}{id_cell(row, link=link)} "
        f"{pad_to(format_minutes(row.my_minutes), MINUTES_WIDTH + 1, right=True)}  "
        f"{pad_to(escape(fit_text(lane_cell(row), GROUP_LANE_WIDTH)), GROUP_LANE_WIDTH)} "
        f"{pad_to(short_date(row.card.updated, today), DATE_WIDTH + 1)} "
        f"{source_marks(row.sources)} {escape(fit_text(row.card.title, budget))}"
    )


def render_footer(
    rows: list[StatusRow], collected: Collected, *, console: Console, since_day: str, since: str
) -> None:
    """Подвал: сколько карточек, сколько времени за окно и на какие типы работ."""
    total, by_role = summarise_minutes(collected.logs, since_day)
    open_count = sum(1 for r in rows if not r.closed)
    console.print(
        f"[dim]└─ {len(rows)} {plural_cards(len(rows))} "
        f"({open_count} в работе, {len(rows) - open_count} закрыто)"
        f" · за {since} списано {format_minutes(total)}[/dim]"
    )
    if by_role:
        roles = " · ".join(f"{escape(name)} {format_minutes(mins)}" for name, mins in by_role)
        console.print(f"[dim]   {roles}[/dim]")
    touched = sum(1 for r in rows if is_touch_only(r))
    if touched:
        # Одинокий 📝 среди двух десятков строк глазом не ловится, а это как раз сигнал
        # «написал в чужую карточку» — выносим счётчик отдельной строкой.
        console.print(f"[dim]   📝 без участия и времени: {touched} (--source touch)[/dim]")


# ── Машинные форматы ────────────────────────────────────────────────────────────


def row_dict(row: StatusRow) -> dict[str, object]:
    """Строка выдачи → плоский JSON-словарь (ключ есть ⇔ значение осмысленно)."""
    return {
        "id": row.card.id,
        "title": row.card.title,
        "url": row.card.url,
        "stage": row.stage,
        "column": row.card.column_title,
        "board": row.card.board_title,
        "space": row.card.space_title,
        "lane": row.card.lane_title,
        "state": state_label(row.card.state),
        "closed": row.closed,
        "escalated": row.escalated,
        "due_date": row.card.due_date,
        "updated": row.card.updated,
        "my_minutes": row.my_minutes,
        "sources": sorted(row.sources),
    }


def format_row(template: str, n: int, row: StatusRow) -> str:
    """Шаблон `--format` — подстановка через replace (безопасно к `{` в данных)."""
    values = {
        "n": str(n),
        "id": str(row.card.id),
        "title": row.card.title,
        "url": row.card.url,
        "stage": row.stage,
        "board": row.card.board_title or "",
        "lane": row.card.lane_title or "",
        "due": (row.card.due_date or "")[:10],
        "min": str(row.my_minutes),
        "src": "".join(sorted(row.sources)),
    }
    out = template
    for key, val in values.items():
        out = out.replace("{" + key + "}", val)
    return out


def rows_to_md_table(rows: list[StatusRow], today: str) -> str:
    """GFM-таблица для вставки в Kaiten/Telegram."""
    headers = ["ID", "ЭТАП", "ВРЕМЯ", "ОБНОВЛ", "ДОРОЖКА", "TITLE"]
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        cells = [
            str(row.card.id),
            row.stage,
            format_minutes(row.my_minutes),
            short_date(row.card.updated, today),
            lane_cell(row),
            row.card.title,
        ]
        lines.append("| " + " | ".join(_md_cell(c) for c in cells) + " |")
    return "\n".join(lines)


def print_json_rows(rows: list[StatusRow]) -> None:
    print_json([row_dict(r) for r in rows])


def print_url_rows(rows: list[StatusRow]) -> None:
    """Строки `[title](url)` — пайп в `mpu telegram send --md`."""
    for row in rows:
        typer.echo(f"[{_md_link_text(row.card.title)}]({row.card.url})")


def print_template_rows(rows: list[StatusRow], template: str) -> None:
    for i, row in enumerate(rows, start=1):
        typer.echo(format_row(template, i, row))
