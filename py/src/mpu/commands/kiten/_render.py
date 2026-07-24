"""`mpu kiten` — рендер карточек/списков: спека колонок таблицы `ls`, JSON-словари,
GFM-таблицы, markdown одной карточки и наглядный rich-рендер с инлайн-скриншотами."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from mpu.lib import kaiten_cache, kaiten_render
from mpu.lib.kaiten import state_label

# Публичный API модуля для остального пакета `kiten` (`_`-имена рендера — общие для
# подмодулей команд; `__all__` помечает это как намеренный экспорт).
__all__ = [
    "_card_detail_dict",
    "_card_dict",
    "_card_to_markdown",
    "_cards_to_md_table",
    "_format_card",
    "_md_cell",
    "_md_link_text",
    "_print_cards",
    "_render_card_rich",
]

if TYPE_CHECKING:
    # Только аннотации: runtime-импорт моделей тянет pydantic (~150 мс) в startup.
    from mpu.lib.kaiten_models import (
        KaitenCard,
        KaitenCardDetail,
        KaitenComment,
        KaitenMember,
    )


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


def _card_dict(c: KaitenCard) -> dict[str, object]:
    return {
        "id": c.id,
        "state": state_label(c.state),
        "due_date": c.due_date,
        "updated": c.updated,
        "title": c.title,
        "url": c.url,
    }


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


def _render_card_rich(  # noqa: C901
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
