"""`mpu kiten desc` — заменить описание карточки (GFM markdown).

Read-аналог (посмотреть текущее описание) — `mpu kiten card <selector> --md`.
"""

from __future__ import annotations

import sys
from typing import Annotated

import typer

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, CardArg, _parse_card_ref
from mpu.commands.kiten.comment import resolve_comment_text
from mpu.lib.cli_err import die
from mpu.lib.kaiten import KaitenAPIError, KaitenClient, card_url


@app.command("desc")
def desc(
    selector: CardArg,
    message: Annotated[
        str | None, typer.Option("--message", "-m", help="Новое описание строкой")
    ] = None,
    body_file: Annotated[
        str | None, typer.Option("--body-file", "-F", help="Файл с описанием; `-` — stdin")
    ] = None,
) -> None:
    """Заменить описание карточки ЦЕЛИКОМ (GFM markdown). Источник — ровно один из `-m`/`-F`.

    Описание уходит в API как есть, ничего не экранируется — в отличие от вставки через
    веб-редактор Kaiten, который дописывает обратные слэши перед спецсимволами markdown
    (списки, скобки, тильды) и ломает разметку. Типовая поломка «md вставился
    экранированным» чинится именно этой командой: перезалить чистый markdown.

    ⚠️ Чекбоксы `- [ ]` в описании Kaiten НЕ работают: редактор рендерит их обычным
    списком с литеральным «[ ]» в тексте. Интерактивные чекбоксы — только отдельная
    сущность «чек-лист карточки»: чек-листы создаёт `mpu kiten checklist add`, а из
    описания пункты-чекбоксы лучше убрать (оставить ссылку «см. чек-лист карточки»).

    Затрагивается ТОЛЬКО описание: чек-листы, вложения, комментарии, поля и учёт времени
    живут отдельными сущностями карточки и переживают замену без изменений.

    Прочитать текущее описание перед правкой — `mpu kiten card <selector> --md`.
    """
    card_id = _parse_card_ref(selector)
    text = resolve_comment_text(message, body_file, stdin_read=sys.stdin.read)
    client = KaitenClient.from_env()
    try:
        client.update_card_description(card_id, text)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} desc: kaiten error: {e}")
    typer.echo(
        f"ok: описание заменено ({len(text)} символов) · {card_url(client.base_url, card_id)}"
    )
