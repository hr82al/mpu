"""`mpu telegram <send|ls>` — Telegram от имени пользователя (telethon, user-session).

- `mpu telegram send "<текст>" [--chat X] [--md]` — отправить сообщение. Адресат: `--chat`
  (override) или `TELEGRAM_DEFAULT_CHAT` из .env. Принимает `@username`, числовой id,
  ссылку t.me, телефон или `me` (Избранное). `-` вместо текста → читать из stdin.
  `--md` — Markdown (`[текст](url)` → ссылка).
- `mpu telegram ls [запрос] [--limit N] [--table]` — найти адресата (id, title, kind,
  username): с аргументом — поиск по имени/@username (контакты + глобально), без — последние
  диалоги. По умолчанию JSON; `--table` — для человека.

Вход (логин) выполняется один раз при `mpu init` (см. cli.py). Креды и сессия — в
~/.config/mpu/.env: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION (пишется
автоматически), TELEGRAM_DEFAULT_CHAT (опц.). Прокси для telethon — TELEGRAM_PROXY (иначе
системные HTTPS_PROXY/https_proxy). Подробнее — mpu.lib.telegram.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Annotated, NoReturn

import typer
from rich.console import Console
from rich.table import Table

from mpu.lib import env, telegram
from mpu.lib.telegram import TgError, TgNotAuthorizedError

COMMAND_NAME = "mpu telegram"
COMMAND_SUMMARY = "Telegram от имени пользователя: `send` — отправить сообщение, `ls` — диалоги"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Telegram от имени пользователя (telethon): send — отправить сообщение, ls — диалоги.

    Вход выполняется один раз при `mpu init`. Креды/сессия — в ~/.config/mpu/.env.
    """


def _fail(message: str) -> NoReturn:
    """Машинно-читаемая ошибка в stderr + выход с кодом 1."""
    typer.echo(message, err=True)
    raise typer.Exit(code=1)


@app.command("send")
def send(
    message: Annotated[str, typer.Argument(help="Текст сообщения; `-` — читать из stdin")],
    chat: Annotated[
        str | None,
        typer.Option(
            "--chat",
            help="Адресат: @username / id / t.me-ссылка / телефон / me. "
            "По умолчанию TELEGRAM_DEFAULT_CHAT из .env",
        ),
    ] = None,
    md: Annotated[
        bool,
        typer.Option("--md", help="Markdown: [текст](url) → ссылка, **жирный**, `код` и т.п."),
    ] = False,
) -> None:
    """Отправить сообщение в чат/группу/канал от имени пользователя.

    `--md` включает Markdown-разметку: `[текст](url)` становится кликабельной ссылкой.
    """
    text = sys.stdin.read() if message == "-" else message
    if not text.strip():
        _fail("telegram: пустой текст сообщения")
    try:
        cfg = telegram.TgConfig.from_env()
        target = telegram.parse_chat_target(
            telegram.resolve_chat(chat, env.get("TELEGRAM_DEFAULT_CHAT"))
        )
        result = asyncio.run(
            telegram.send_message(cfg, target, text, parse_mode="md" if md else None)
        )
    except (TgNotAuthorizedError, TgError) as e:
        _fail(str(e))
    typer.echo(
        json.dumps(
            {"id": result.id, "chat_id": result.chat_id, "date": result.date},
            ensure_ascii=False,
        )
    )


@app.command("ls")
def ls(
    query: Annotated[
        str | None,
        typer.Argument(
            help="Имя или @username для поиска (контакты + глобально). "
            "Без аргумента — последние диалоги"
        ),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", min=1, max=500, help="Сколько результатов")] = 50,
    table: Annotated[
        bool, typer.Option("--table", help="Таблица для человека вместо JSON")
    ] = False,
) -> None:
    """Найти адресата: с аргументом — поиск по имени/username; без — последние диалоги.

    Выводит id, title, kind, username. Для `send --chat` удобнее всего username; адресата
    можно указать и без наличия в этом списке (по @username / телефону / id).
    """
    try:
        cfg = telegram.TgConfig.from_env()
        if query:
            dialogs = asyncio.run(telegram.search_entities(cfg, query, limit))
        else:
            dialogs = asyncio.run(telegram.list_dialogs(cfg, limit))
    except (TgNotAuthorizedError, TgError) as e:
        _fail(str(e))

    if not table:
        typer.echo(
            json.dumps([telegram.dialog_to_dict(d) for d in dialogs], ensure_ascii=False, indent=2)
        )
        return
    if not dialogs:
        typer.echo("(нет диалогов)")
        return
    rich_table = Table(header_style="bold")
    for header in ("ID", "KIND", "USERNAME", "TITLE"):
        rich_table.add_column(header, overflow="fold")
    for d in dialogs:
        rich_table.add_row(str(d.id), d.kind, d.username or "", d.title)
    Console().print(rich_table)
    typer.echo(f"({len(dialogs)} dialogs)")
