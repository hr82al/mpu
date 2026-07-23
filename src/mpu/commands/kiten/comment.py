"""`mpu kiten comment` — комментарий от своего имени: текст/вложения/адресаты, `@all`."""

from __future__ import annotations

import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, CardArg, _parse_card_ref
from mpu.lib.cli_err import die
from mpu.lib.kaiten import KaitenAPIError, KaitenClient, card_url

if TYPE_CHECKING:
    # Только аннотации: runtime-импорт моделей тянет pydantic (~150 мс) в startup.
    from mpu.lib.kaiten_models import KaitenCardDetail

# Публичный API модуля для остального пакета `kiten` (`_expand_all_to_owner` —
# `_`-имя, общее для `move.close`; `__all__` помечает намеренный экспорт).
__all__ = [
    "ALL_MENTION_RE",
    "_expand_all_to_owner",
    "expand_all_mention",
    "expand_recipients",
    "parse_recipients",
    "plan_field_actions",
    "prepend_recipients",
    "read_attachments",
    "resolve_comment_text",
]


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
    selector: CardArg,
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
        die(f"{COMMAND_NAME} comment: kaiten error: {e}")
    typer.echo(f"ok: комментарий {created.id} → {card_url(client.base_url, card_id)}")
    if attachments:
        typer.echo(f"   вложения: {', '.join(name for name, _ in attachments)}")
    if mentioned:
        unique = list(dict.fromkeys(mentioned))
        typer.echo(f"   адресаты: {' '.join('@' + h for h in unique)}")
