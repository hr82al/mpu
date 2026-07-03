"""`mpu kiten card` — одна карточка: наглядный rich-рендер / `--md` / `--json`."""

from __future__ import annotations

import sys
from typing import Annotated

import typer

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, _parse_card_ref
from mpu.commands.kiten._render import _card_detail_dict, _card_to_markdown, _render_card_rich
from mpu.lib import kaiten_cache
from mpu.lib.cli_err import die
from mpu.lib.cli_out import print_json
from mpu.lib.kaiten import KaitenAPIError, KaitenClient


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
        die(f"{COMMAND_NAME} card: kaiten error: {e}")

    prop_names = kaiten_cache.property_names()
    if out_json:
        print_json(_card_detail_dict(detail, comment_list))
        return
    # Пайп (не TTY) и не --json → markdown: `mpu kiten card X | <llm>` отдаёт чистый GFM.
    if md or not sys.stdout.isatty():
        typer.echo(_card_to_markdown(detail, comment_list, prop_names))
        return
    _render_card_rich(detail, comment_list, prop_names, images=images)
