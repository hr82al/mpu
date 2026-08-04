"""`mpu telegram <send|ls>` — Telegram от имени пользователя (telethon, user-session).

- `mpu telegram send "<текст>" [--chat X] [--md] [-f PATH ...]` — отправить сообщение или
  файл(ы). Адресат: `--chat` (override) или `TELEGRAM_DEFAULT_CHAT` из .env. Принимает
  `@username`, числовой id, ссылку t.me, телефон, `me` (Избранное) или НАЗВАНИЕ чата
  (`DEV | ALEXANDER KHROMOV` — как в `ls`; неоднозначное название → ошибка со списком).
  `-` вместо текста → читать из stdin. `--md` — Markdown (`[текст](url)` → ссылка).
  `-f/--file PATH` — приложить файл документом (повторяй для нескольких); текст становится
  подписью (допускается пустой).
- `mpu telegram ls [запрос] [--limit N] [--table]` — найти адресата (id, title, kind,
  username): с аргументом — поиск по имени/@username (контакты + глобально), без — последние
  диалоги. По умолчанию JSON; `--table` — для человека.
- `mpu telegram search [текст] [--chat X] [--from Y] [--limit N] [--table]` — полнотекстовый
  поиск ПО СОДЕРЖИМОМУ сообщений: без `--chat` — глобально по всем диалогам, с `--chat` — в
  одном; `--from` — только от этого отправителя (внутри `--chat` серверно, глобально —
  клиентски, нужен текст). Выводит chat/sender/date/text/link. Пустой текст — только с `--chat`.
- `mpu telegram status [--chat X] [--live/--no-live] [--dry-run]` — отправить нумерованный
  список карточек Kaiten, перемещённых мной сегодня (МСК): `N. [Заголовок](ссылка) — Колонка
  эмодзи`. Источник — локальный журнал перемещений (`mpu kiten move`/`ready`/`review`); `--live`
  (по умолч.) добавляет ходы из Kaiten, сделанные не через инструмент. `KITEN_STATUS_EMOJI` —
  JSON-override колонка→эмодзи. `--dry-run` — показать без отправки.
- `mpu telegram login` — интерактивный вход (сохранить пользовательскую сессию в .env);
  идемпотентно (валидная `TELEGRAM_SESSION` → no-op), без TTY — пропуск с подсказкой. То же
  действие выполняет шаг 5 `mpu init`.

Вход выполняется командой `login` (см. выше) либо шагом 5 `mpu init`. Креды и сессия — в
~/.config/mpu/.env: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION (пишется
автоматически), TELEGRAM_DEFAULT_CHAT (опц.). Прокси для telethon — TELEGRAM_PROXY (иначе
системные HTTPS_PROXY/https_proxy). Подробнее — mpu.lib.telegram.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from rich.console import Console
from rich.table import Table

from mpu.lib import env, kaiten_links, kiten_status, store, telegram
from mpu.lib.cli_err import die
from mpu.lib.cli_out import print_json
from mpu.lib.kaiten import DEFAULT_BASE_URL, KaitenAPIError, KaitenClient, card_url
from mpu.lib.kiten_status import StatusEntry
from mpu.lib.telegram import TgError, TgNotAuthorizedError

COMMAND_NAME = "mpu telegram"
COMMAND_SUMMARY = (
    "Telegram от имени пользователя: `login` — вход, `send` — отправить, `ls` — диалоги, "
    "`search` — поиск, `status` — карточки, перемещённые сегодня"
)
_TELEGRAM_MAX = 4096  # лимит длины сообщения Telegram

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Telegram от имени пользователя (telethon): send — отправить, ls — диалоги, search — поиск.

    Вход выполняется один раз при `mpu init`. Креды/сессия — в ~/.config/mpu/.env.
    """


def _fail(message: str) -> NoReturn:
    """Машинно-читаемая ошибка в stderr + выход с кодом 1."""
    die(message)


def _validate_files(paths: list[str]) -> list[str]:
    """Проверить, что каждый путь-вложение существует и это файл; вернуть пути как есть."""
    for path in paths:
        if not Path(path).is_file():
            raise typer.BadParameter(f"файл-вложение не найден: {path}", param_hint="--file")
    return paths


@app.command("send")
def send(
    message: Annotated[str, typer.Argument(help="Текст сообщения; `-` — читать из stdin")],
    chat: Annotated[
        str | None,
        typer.Option(
            "--chat",
            help="Адресат: @username / id / t.me-ссылка / телефон / me / название чата. "
            "По умолчанию TELEGRAM_DEFAULT_CHAT из .env",
        ),
    ] = None,
    md: Annotated[
        bool,
        typer.Option("--md", help="Markdown: [текст](url) → ссылка, **жирный**, `код` и т.п."),
    ] = False,
    files: Annotated[
        list[str] | None,
        typer.Option(
            "--file",
            "-f",
            help="Файл-вложение (САМ файл, не его текст); повторяй -f для нескольких. "
            "Текст становится подписью.",
        ),
    ] = None,
) -> None:
    """Отправить сообщение или файл(ы) в чат/группу/канал от имени пользователя.

    `--md` включает Markdown-разметку: `[текст](url)` становится кликабельной ссылкой.
    `-f PATH` — приложить файл(ы) документом; текст уходит подписью (можно пустой).
    """
    text = sys.stdin.read() if message == "-" else message
    paths = _validate_files(files) if files else []
    if not paths and not text.strip():
        _fail("telegram: пустой текст сообщения")
    try:
        cfg = telegram.TgConfig.from_env()
        target = telegram.parse_chat_target(
            telegram.resolve_chat(chat, env.get("TELEGRAM_DEFAULT_CHAT"))
        )
        parse_mode = "md" if md else None
        if paths:
            caption = text if text.strip() else None
            result = asyncio.run(
                telegram.send_file(cfg, target, paths, caption=caption, parse_mode=parse_mode)
            )
        else:
            result = asyncio.run(telegram.send_message(cfg, target, text, parse_mode=parse_mode))
    except (TgNotAuthorizedError, TgError) as e:
        _fail(str(e))
    typer.echo(
        json.dumps(
            {"id": result.id, "chat_id": result.chat_id, "date": result.date},
            ensure_ascii=False,
        )
    )


def _truncate(text: str, limit: int = _TELEGRAM_MAX) -> str:
    """Обрезать текст до лимита Telegram, добавив маркер обрезки."""
    if len(text) <= limit:
        return text
    marker = "\n…(обрезано)"
    return text[: limit - len(marker)] + marker


def _local_move_entries(since: int, until: int) -> list[StatusEntry]:
    """Перемещения из локального журнала `kaiten_card_moves` за окно [since, until]."""
    with store.store() as conn:
        store.bootstrap(conn)
        moves = kaiten_links.list_moves(conn, since=since, until=until)
    base = env.get("KITEN_BASE_URL") or DEFAULT_BASE_URL
    return [
        StatusEntry(
            card_id=m.card_id,
            title=m.title,
            url=m.url or card_url(base, m.card_id),
            column=m.to_column,
            moved_at=m.moved_at,
        )
        for m in moves
    ]


def _live_move_entries(client: KaitenClient) -> list[StatusEntry]:
    """Мои перемещения за сегодня из Kaiten (location-history по карточкам, тронутым сегодня) —
    ловит ходы, сделанные не через инструмент. Может бросить KaitenAPIError (ловим в команде)."""
    me = client.current_user()
    iso_from, iso_to = kiten_status.today_iso_window()
    cards = client.list_cards(member_ids=str(me.id), updated_after=iso_from, updated_before=iso_to)
    board_ids = {c.board_id for c in cards if c.board_id is not None}
    columns = client.list_columns(list(board_ids)) if board_ids else []
    col_title = {c.id: c.title for c in columns}
    out: list[StatusEntry] = []
    for card in cards:
        mine_today = [
            h
            for h in client.location_history(card.id)
            if h.author_id == me.id and kiten_status.is_today_msk(h.changed)
        ]
        if not mine_today:
            continue
        latest = max(mine_today, key=lambda h: kiten_status.iso_to_epoch(h.changed))
        column = (
            col_title.get(latest.column_id, str(latest.column_id))
            if latest.column_id is not None
            else "—"
        )
        out.append(
            StatusEntry(
                card_id=card.id,
                title=card.title,
                url=card.url,
                column=column,
                moved_at=kiten_status.iso_to_epoch(latest.changed),
            )
        )
    return out


@app.command("status")
def status(
    chat: Annotated[
        str | None,
        typer.Option(
            "--chat",
            help="Адресат: @username / id / t.me / телефон / me / название чата. "
            "По умолч. TELEGRAM_DEFAULT_CHAT",
        ),
    ] = None,
    live: Annotated[
        bool,
        typer.Option(
            "--live/--no-live",
            help="Дополнить данными из Kaiten (ходы вне инструмента); --no-live — только журнал",
        ),
    ] = True,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать сообщение без отправки")
    ] = False,
) -> None:
    """Отправить в Telegram нумерованный список карточек, перемещённых мной сегодня (МСК).

    Каждая строка: `N. [Заголовок](ссылка) — Колонка эмодзи` (✅ для «Готово»). Источник —
    локальный журнал перемещений (`mpu kiten move`/`ready`/`review`); с `--live` (по умолчанию)
    добавляются перемещения из Kaiten, сделанные не через инструмент.
    Сообщение длиннее 4096 символов (лимит Telegram) обрезается с маркером.
    """
    since, until = kiten_status.today_epoch_window()
    entries = _local_move_entries(since, until)
    if live:
        try:
            entries += _live_move_entries(KaitenClient.from_env())
        except KaitenAPIError as e:
            typer.echo(f"{COMMAND_NAME} status: live-обогащение пропущено (Kaiten: {e})", err=True)
    text = kiten_status.build_status_text(
        entries,
        label=kiten_status.today_label(),
        emoji_overrides=kiten_status.load_emoji_overrides(),
        column_overrides=kiten_status.load_column_map(),
    )
    if dry_run:
        typer.echo(text)
        return
    try:
        cfg = telegram.TgConfig.from_env()
        target = telegram.parse_chat_target(
            telegram.resolve_chat(chat, env.get("TELEGRAM_DEFAULT_CHAT"))
        )
        result = asyncio.run(telegram.send_message(cfg, target, _truncate(text), parse_mode="md"))
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
        print_json([telegram.dialog_to_dict(d) for d in dialogs])
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


@app.command("search")
def search(
    query: Annotated[
        str,
        typer.Argument(
            help="Текст для поиска по содержимому сообщений (по словам). "
            "Можно опустить только если задан --chat (история чата)"
        ),
    ] = "",
    chat: Annotated[
        str | None,
        typer.Option(
            "--chat",
            help="Искать только в этом чате (@username / id / t.me / телефон / me / название). "
            "По умолчанию — глобально по всем диалогам",
        ),
    ] = None,
    from_user: Annotated[
        str | None,
        typer.Option(
            "--from",
            help="Оставить только сообщения этого отправителя (@username / id / телефон / имя). "
            "Без --chat — клиентский фильтр поверх глобального поиска (нужен текст)",
        ),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", min=1, max=500, help="Сколько сообщений")] = 50,
    table: Annotated[
        bool, typer.Option("--table", help="Таблица для человека вместо JSON")
    ] = False,
) -> None:
    """Поиск ПО СОДЕРЖИМОМУ сообщений: без --chat — глобально, с --chat — в одном чате.

    `--from` фильтрует по отправителю (внутри --chat — серверно; глобально — клиентски, нужен
    текст). Пустой текст допустим только с --chat (история чата). Выводит id, chat_id,
    chat_title, sender, date, text, link. По умолчанию JSON; `--table` — для человека.
    """
    try:
        cfg = telegram.TgConfig.from_env()
        chat_target = (
            telegram.parse_chat_target(telegram.resolve_chat(chat, None)) if chat else None
        )
        from_target = (
            telegram.parse_chat_target(telegram.resolve_chat(from_user, None))
            if from_user
            else None
        )
        messages = asyncio.run(
            telegram.search_messages(
                cfg, query, chat=chat_target, from_user=from_target, limit=limit
            )
        )
    except (TgNotAuthorizedError, TgError) as e:
        _fail(str(e))

    if not table:
        print_json([telegram.message_to_dict(m) for m in messages])
        return
    if not messages:
        typer.echo("(ничего не найдено)")
        return
    rich_table = Table(header_style="bold")
    for header in ("DATE", "CHAT", "SENDER", "TEXT"):
        rich_table.add_column(header, overflow="fold")
    for m in messages:
        rich_table.add_row(m.date or "", m.chat_title, m.sender or "", m.text)
    Console().print(rich_table)
    typer.echo(f"({len(messages)} messages)")


def _read_stdin_line() -> str:
    """Прочитать строку из stdin В ОБХОД readline.

    `input()` под GNU readline на ряде терминалов/локалей падает UnicodeDecodeError даже на
    ASCII-промпте (readline при перерисовке строки подмешивает байты предыдущего вывода).
    Читаем сырые байты и декодируем utf-8 с заменой битых — line-editing для setup-промптов
    не нужен. EOF → пустая строка.
    """
    raw = sys.stdin.buffer.readline()
    return raw.decode("utf-8", "replace").strip()


def _ask(label: str) -> str:
    """Видимый вопрос: label → stderr (без перевода строки), ответ ← stdin (без readline)."""
    typer.echo(label, nl=False, err=True)
    return _read_stdin_line()


def _ask_yes_no(label: str) -> bool:
    """y/N вопрос (дефолт — No)."""
    return _ask(f"{label} [y/N]: ").lower() in ("y", "yes")


def _ask_secret(label: str) -> str:
    """Скрытый ввод (2FA-пароль). getpass не использует GNU readline; при сбое — видимый ввод."""
    import getpass

    try:
        return getpass.getpass(label).strip()
    except (EOFError, OSError, UnicodeError):
        return _ask(label)


def _ensure_telegram_creds() -> bool:
    """Гарантировать TELEGRAM_API_ID/HASH в .env. Спросить с объяснением, если их нет.

    Возвращает True, если creds на месте (или введены), False — если пользователь отказался
    / ввёл пусто. Пишет введённые значения в ~/.config/mpu/.env.
    """
    if env.get("TELEGRAM_API_ID") and env.get("TELEGRAM_API_HASH"):
        return True
    typer.echo(
        "# telegram: не настроен. Для отправки сообщений от вашего имени нужны api_id и\n"
        "#   api_hash с https://my.telegram.org → 'API development tools' (войти по номеру,\n"
        "#   создать приложение: App title / short name любые, Platform — Other).",
        err=True,
    )
    if not _ask_yes_no("Set up Telegram now?"):
        typer.echo(
            "# telegram: пропущено (позже: заполнить TELEGRAM_API_ID/HASH в .env и "
            "`mpu telegram login`)",
            err=True,
        )
        return False
    typer.echo(
        "# После создания приложения на my.telegram.org страница покажет два значения\n"
        "#   (блок 'App configuration'):\n"
        "#   • api_id   — целое число, идентификатор приложения (напр. 1234567);\n"
        "#   • api_hash — строка из 32 hex-символов, секрет приложения\n"
        "#                (напр. 0123456789abcdef0123456789abcdef).\n"
        "#   Это креды ПРИЛОЖЕНИЯ (не вашего аккаунта), общие для всех ваших чатов;\n"
        "#   вводятся один раз, хранятся в ~/.config/mpu/.env.",
        err=True,
    )
    api_id = _ask("api_id (integer): ")
    api_hash = _ask("api_hash (32 hex chars): ")
    if not (api_id and api_hash):
        typer.echo("# telegram: пропущено (api_id/api_hash пустые)", err=True)
        return False
    env.set_persistent("TELEGRAM_API_ID", api_id)
    env.set_persistent("TELEGRAM_API_HASH", api_hash)
    typer.echo("# telegram: api_id/api_hash записаны в .env", err=True)
    return True


def run_login_step() -> None:
    """Интерактивный вход в Telegram (идемпотентно, best-effort).

    Общая реализация для `mpu telegram login` и шага 5 `mpu init` (см. cli.py) —
    единственного интерактивного шага bootstrap'а, спрашивающего только при TTY.
    """
    if env.get("TELEGRAM_SESSION"):
        typer.echo("# telegram: уже авторизован, пропускаю", err=True)
        return
    if not sys.stdin.isatty():
        typer.echo(
            "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)",
            err=True,
        )
        return
    if not _ensure_telegram_creds():
        return
    try:
        cfg = telegram.TgConfig.from_env()
        phone = env.get("TELEGRAM_PHONE")
        if not phone:
            phone = _ask("Telegram phone (e.g. +79991234567): ")
            env.set_persistent("TELEGRAM_PHONE", phone)
        session = asyncio.run(
            telegram.interactive_login(
                cfg,
                phone=phone,
                prompt_code=lambda: _ask("Telegram login code (from Telegram): "),
                prompt_password=lambda: _ask_secret("2FA password: "),
            )
        )
        env.set_persistent("TELEGRAM_SESSION", session)
        typer.echo("# telegram: авторизован, сессия записана в .env", err=True)
    except telegram.TgError as e:
        typer.echo(f"# telegram: пропущено ({e})", err=True)


@app.command("login")
def login() -> None:
    """Войти в Telegram: сохранить пользовательскую сессию (telethon) в ~/.config/mpu/.env.

    Интерактивный сценарий: если TELEGRAM_API_ID/TELEGRAM_API_HASH ещё не заданы — сначала
    спрашивает согласие их завести (с инструкцией, где на my.telegram.org взять api_id/
    api_hash) и сохраняет их. Дальше спрашивает телефон (или берёт TELEGRAM_PHONE из .env),
    код из Telegram и, если включена 2FA, пароль (скрытый ввод через getpass). Успешный вход
    сохраняет TELEGRAM_PHONE и TELEGRAM_SESSION в ~/.config/mpu/.env — дальше `send`/`ls`/
    `search`/`status` используют их без повторного входа.

    Идемпотентно: если TELEGRAM_SESSION уже валидна — печатает «уже авторизован» и выходит,
    повторный вход не запускается. Без TTY (неинтерактивный запуск) — пропускает с подсказкой
    заполнить TELEGRAM_API_ID/HASH в .env вручную. Best-effort: ошибка входа (telethon
    TgError, например неверный код) не считается фатальной — печатается в stderr, команда
    завершается кодом 0.

    То же самое действие выполняется шагом 5 `mpu init` (после discovery Portainer/Loki/
    Kaiten) — вызывать отдельно, если тогда TTY не было или креды завели позже.
    """
    run_login_step()
