"""Telethon-слой для `mpu telegram` — отправка сообщений от имени пользователя (user-session).

Изолирует всё взаимодействие с telethon (внешняя библиотека, типизирована неполно, без
py.typed). Наружу отдаёт собственные dataclass'ы (TgDialog / TgSentMessage / TgMessage); чистые
функции (resolve_chat / parse_chat_target / parse_proxy_url / dialog_to_dict / message_to_dict /
message_link) тестируются без сети — сам сетевой I/O, как и в lib/kaiten.py, тестами не покрывается.

Прокси: трафик telethon идёт через TELEGRAM_PROXY (если задан), иначе через стандартные
HTTPS_PROXY/https_proxy. Поддержаны http/https (CONNECT) и socks5/socks4. ВАЖНО: HTTPS_PROXY
в ~/.config/mpu/.env через dotenv утекает в os.environ и проксирует ВЕСЬ трафик mpu (urllib
kaiten и т.п.) — для прокси только под Telegram использовать TELEGRAM_PROXY. См. resolve_proxy.

ENV (~/.config/mpu/.env):
- TELEGRAM_API_ID, TELEGRAM_API_HASH — креды с https://my.telegram.org (обязательны).
- TELEGRAM_SESSION — StringSession, пишется автоматически при `mpu init`.
- TELEGRAM_PROXY — прокси ТОЛЬКО для telethon (опц.); fallback — системные HTTPS_PROXY/https_proxy.

pyright strict: telethon без типов → "unknown"-правила подавлены на уровне модуля (ниже).
Это и есть единственная граница с нетипизированной библиотекой; чистые функции работают
со str/int/dict и под подавление не попадают (их типы конкретны, правила на них не срабатывают).
"""

# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict
from urllib.parse import unquote, urlparse

from mpu.lib import env

if TYPE_CHECKING:
    from telethon import TelegramClient

# telethon импортируется ЛЕНИВО внутри I/O-функций (≈400 ms на импорт). `_mount` в cli.py
# грузит все командные модули eager при каждом запуске `mpu` — держать telethon на верхнем
# уровне = +400 ms к старту любой команды. Чистые функции и dataclass'ы telethon не требуют.

_INT_RE = re.compile(r"-?\d+")

# Маркировка id супергрупп/каналов в telethon (utils.get_peer_id): `-(10^12 + raw)`.
_CHANNEL_ID_BASE = 1_000_000_000_000

# Сколько глобальных текстовых совпадений просканировать при клиентском from-фильтре
# (см. search_messages: глобальный from-поиск telethon делать не умеет). Совпадений
# по отправителю наберём максимум `limit`, но сам скан этим числом ограничен.
_GLOBAL_FROM_SCAN_LIMIT = 1000

_PROXY_SCHEMES: dict[str, str] = {
    "http": "http",
    "https": "http",
    "socks5": "socks5",
    "socks5h": "socks5",
    "socks4": "socks4",
    "socks4a": "socks4",
}


class TgError(RuntimeError):
    """Ошибка взаимодействия с Telegram. Сообщение машинно-читаемое: `telegram: <причина>`."""


class TgNotAuthorizedError(TgError):
    """Сессия отсутствует или протухла — нужно заново пройти `mpu init`."""


# ── Конфиг / типы вывода ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class TgConfig:
    api_id: int
    api_hash: str
    session: str | None

    @classmethod
    def from_env(cls) -> TgConfig:
        """Собрать конфиг из .env. Бросает TgError, если creds не заданы / api_id не число."""
        api_id_raw = _require("TELEGRAM_API_ID")
        try:
            api_id = int(api_id_raw)
        except ValueError:
            raise TgError(
                f"telegram: TELEGRAM_API_ID должен быть числом, получено {api_id_raw!r}"
            ) from None
        return cls(
            api_id=api_id,
            api_hash=_require("TELEGRAM_API_HASH"),
            session=env.get("TELEGRAM_SESSION"),
        )


@dataclass(frozen=True)
class TgDialog:
    id: int
    title: str
    kind: str  # "user" | "bot" | "group" | "channel" | "unknown"
    username: str | None


@dataclass(frozen=True)
class TgSentMessage:
    id: int
    chat_id: int
    date: str | None  # ISO 8601 (UTC, как отдаёт Telegram)


@dataclass(frozen=True)
class TgMessage:
    id: int
    chat_id: int
    chat_title: str
    sender: str | None  # имя/username отправителя; None если Telegram его не отдал
    date: str | None  # ISO 8601 (UTC, как отдаёт Telegram)
    text: str
    link: str | None  # t.me-ссылка на сообщение; None если чат без публичной ссылки


def _require(name: str) -> str:
    """env.require, но ошибка обёрнута в TgError (единый тип для перехвата в команде)."""
    try:
        return env.require(name)
    except RuntimeError as e:
        raise TgError(f"telegram: {e}") from None


# ── Чистые функции (тестируются без сети) ────────────────────────────────────


def resolve_chat(cli_chat: str | None, env_chat: str | None) -> str:
    """Адресат: --chat (CLI) имеет приоритет над TELEGRAM_DEFAULT_CHAT (env).

    Оба пусты → TgError (ошибка ДО подключения к сети).
    """
    chat = cli_chat if cli_chat is not None else env_chat
    if not chat or not chat.strip():
        raise TgError("telegram: адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env")
    return chat.strip()


def parse_chat_target(raw: str) -> str | int:
    """Нормализовать адресат в то, что принимает telethon get_entity.

    - `https://t.me/<name>` / `t.me/<name>` → `<name>` (публичный username);
    - `@username` → `username`;
    - числовой id (в т.ч. отрицательный для групп/каналов) → int;
    - всё прочее (телефон `+7...`, username, спец-имя `me`) → строка как есть.
    """
    s = raw.strip()
    for prefix in ("https://t.me/", "http://t.me/", "t.me/"):
        if s.startswith(prefix):
            tail = s[len(prefix) :].strip("/")
            return tail or s
    if s.startswith("@"):
        return s[1:]
    if _INT_RE.fullmatch(s):
        return int(s)
    return s


def dialog_to_dict(d: TgDialog) -> dict[str, object]:
    """TgDialog → dict для JSON-вывода (ключ присутствует ⇔ значение осмысленно)."""
    return {"id": d.id, "title": d.title, "kind": d.kind, "username": d.username}


def message_to_dict(m: TgMessage) -> dict[str, object]:
    """TgMessage → dict для JSON-вывода."""
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "chat_title": m.chat_title,
        "sender": m.sender,
        "date": m.date,
        "text": m.text,
        "link": m.link,
    }


def message_link(chat_id: int, message_id: int, username: str | None) -> str | None:
    """t.me-ссылка на сообщение по id чата и сообщения.

    - публичный чат/канал с username → `https://t.me/<username>/<id>`;
    - супергруппа/канал без username (marked id `-(10^12 + raw)`) → `https://t.me/c/<raw>/<id>`;
    - приватный диалог / базовая группа (нет публичной ссылки) → None.
    """
    if username:
        return f"https://t.me/{username}/{message_id}"
    if chat_id <= -_CHANNEL_ID_BASE:
        raw = -chat_id - _CHANNEL_ID_BASE
        return f"https://t.me/c/{raw}/{message_id}"
    return None


class ProxyDict(TypedDict):
    proxy_type: str
    addr: str
    port: int
    rdns: bool
    username: str | None
    password: str | None


def parse_proxy_url(url: str | None) -> ProxyDict | None:
    """Прокси-URL → dict для `TelegramClient(proxy=...)` (формат python_socks). None если пусто.

    Схемы: http/https → HTTP CONNECT; socks5/socks5h → socks5; socks4/socks4a → socks4.
    Требуется host:port. Креды (`user:pass@`) percent-декодируются. rdns=True — резолв
    DNS на стороне прокси.
    """
    if not url or not url.strip():
        return None
    parsed = urlparse(url.strip())
    proxy_type = _PROXY_SCHEMES.get(parsed.scheme.lower())
    if proxy_type is None:
        raise TgError(
            f"telegram: неподдерживаемая схема прокси {parsed.scheme!r}; "
            "попробуй: http/https/socks5/socks4"
        )
    if not parsed.hostname or not parsed.port:
        raise TgError(f"telegram: в прокси-URL нужен host:port — {url!r}")
    return ProxyDict(
        proxy_type=proxy_type,
        addr=parsed.hostname,
        port=parsed.port,
        rdns=True,
        username=unquote(parsed.username) if parsed.username else None,
        password=unquote(parsed.password) if parsed.password else None,
    )


def resolve_proxy() -> ProxyDict | None:
    """Прокси для telethon: TELEGRAM_PROXY (приоритет), иначе стандартные HTTPS_PROXY/https_proxy.

    TELEGRAM_PROXY — отдельное имя НАМЕРЕННО: HTTPS_PROXY, положенный в ~/.config/mpu/.env,
    через dotenv попадает в os.environ и его подхватывают urllib/httpx → проксируется ВЕСЬ
    трафик mpu (kaiten и т.п.), а не только telethon. Для прокси только под Telegram —
    класть значение в TELEGRAM_PROXY. HTTPS_PROXY/https_proxy уважаются как системный fallback.
    """
    return parse_proxy_url(
        env.get("TELEGRAM_PROXY") or env.get("HTTPS_PROXY") or env.get("https_proxy")
    )


# ── Сетевой I/O (async; вызывается из команд через asyncio.run) ──────────────


def _make_client(cfg: TgConfig) -> TelegramClient:
    """TelegramClient на StringSession + прокси из env. Создавать ВНУТРИ asyncio.run."""
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    session = StringSession(cfg.session or "")
    # telethon-стаб типизирует proxy как tuple|dict (без None и без TypedDict): в рантайме
    # dict из parse_proxy_url валиден, а None = «без прокси» (дефолт telethon).
    return TelegramClient(
        session,
        cfg.api_id,
        cfg.api_hash,
        proxy=resolve_proxy(),  # pyright: ignore[reportArgumentType]
    )


async def _disconnect(client: TelegramClient) -> None:
    """Безопасный disconnect: telethon возвращает coroutine когда есть что закрывать."""
    coro = client.disconnect()
    if coro is not None:
        await coro


async def _ensure_authorized(client: TelegramClient) -> None:
    await client.connect()
    if not await client.is_user_authorized():
        raise TgNotAuthorizedError("telegram: не авторизован; запусти `mpu init`")


def _save_session(client: TelegramClient) -> str:
    """Строка StringSession активного клиента (после успешной авторизации)."""
    session = client.session
    if session is None:
        raise TgError("telegram: сессия не инициализирована")
    return str(session.save())


async def send_message(
    cfg: TgConfig, target: str | int, text: str, *, parse_mode: str | None = None
) -> TgSentMessage:
    """Отправить `text` в `target` от имени пользователя. TgNotAuthorizedError если нет сессии.

    `parse_mode="md"` — Markdown: `[текст](url)` → ссылка, `**жирный**` и т.п. None — как есть.
    """
    from telethon.errors import FloodWaitError, RPCError

    client = _make_client(cfg)
    try:
        await _ensure_authorized(client)
        try:
            msg = await client.send_message(target, text, parse_mode=parse_mode)
        except ValueError as e:
            raise TgError(f"telegram: не удалось найти чат {target!r}: {e}") from None
        except FloodWaitError as e:
            raise TgError(f"telegram: rate-limit, подожди {e.seconds}s") from None
        except RPCError as e:
            raise TgError(f"telegram: RPC error: {e}") from None
        date = msg.date.isoformat() if msg.date is not None else None
        # chat_id — property Message (есть в рантайме, нет в стабе) → читаем через getattr.
        chat_id = getattr(msg, "chat_id", None)
        return TgSentMessage(
            id=int(msg.id),
            chat_id=int(chat_id) if chat_id is not None else 0,
            date=date,
        )
    finally:
        await _disconnect(client)


async def list_dialogs(cfg: TgConfig, limit: int) -> list[TgDialog]:
    """Последние диалоги (id, title, kind, username) — чтобы найти адресата для --chat."""
    from telethon.errors import FloodWaitError, RPCError

    client = _make_client(cfg)
    out: list[TgDialog] = []
    try:
        await _ensure_authorized(client)
        try:
            async for dialog in client.iter_dialogs(limit=limit):
                out.append(_dialog_from_telethon(dialog))
        except FloodWaitError as e:
            raise TgError(f"telegram: rate-limit, подожди {e.seconds}s") from None
        except RPCError as e:
            raise TgError(f"telegram: RPC error: {e}") from None
    finally:
        await _disconnect(client)
    return out


async def search_entities(cfg: TgConfig, query: str, limit: int) -> list[TgDialog]:
    """Поиск пользователей/чатов/каналов по имени или @username (контакты + глобально).

    Нужен, чтобы найти адресата, которого нет в недавних диалогах (`list_dialogs`).
    """
    from telethon.errors import FloodWaitError, RPCError
    from telethon.tl.functions.contacts import SearchRequest

    client = _make_client(cfg)
    out: list[TgDialog] = []
    seen: set[int] = set()
    try:
        await _ensure_authorized(client)
        try:
            res = await client(SearchRequest(q=query, limit=limit))
        except FloodWaitError as e:
            raise TgError(f"telegram: rate-limit, подожди {e.seconds}s") from None
        except RPCError as e:
            raise TgError(f"telegram: RPC error: {e}") from None
        for entity in [*res.users, *res.chats]:
            dialog = _entity_to_dialog(entity)
            if dialog.id not in seen:
                seen.add(dialog.id)
                out.append(dialog)
    finally:
        await _disconnect(client)
    return out


async def search_messages(
    cfg: TgConfig,
    query: str,
    *,
    chat: str | int | None,
    from_user: str | int | None,
    limit: int,
) -> list[TgMessage]:
    """Полнотекстовый поиск сообщений (history-search).

    - `chat=None` → глобально по всем диалогам (`messages.searchGlobal`); иначе — внутри чата
      (`messages.search`).
    - `from_user` (опц.) — оставить только сообщения этого отправителя. ВНУТРИ `chat` фильтр
      серверный; ГЛОБАЛЬНО (без `chat`) telethon его не умеет (подставляет InputPeerEmpty →
      messages.search падает), поэтому глобальный from-фильтр делаем КЛИЕНТСКИ поверх текстового
      searchGlobal — нужен непустой `query`, скан ограничен `_GLOBAL_FROM_SCAN_LIMIT`.
    - пустой `query` вместе с `chat` → просто история чата (без текстового фильтра).

    Пустой `query` БЕЗ `chat` запрещён (глобальный дамп всего) → TgError.
    """
    from telethon.errors import FloodWaitError, RPCError

    client = _make_client(cfg)
    out: list[TgMessage] = []
    try:
        await _ensure_authorized(client)
        entity = None
        if chat is not None:
            try:
                entity = await client.get_input_entity(chat)
            except (ValueError, TypeError) as e:
                raise TgError(f"telegram: не удалось найти чат {chat!r}: {e}") from None
        sender = None
        if from_user is not None:
            try:
                sender = await client.get_input_entity(from_user)
            except (ValueError, TypeError) as e:
                raise TgError(
                    f"telegram: не удалось найти отправителя {from_user!r}: {e}"
                ) from None

        # Глобальный from-фильтр (sender задан, chat — нет) фильтруем клиентски: нужен текст.
        global_from = entity is None and sender is not None
        if global_from and not query:
            raise TgError(
                "telegram: --from без --chat требует текст запроса "
                "(глобальный поиск по отправителю — только с текстом)"
            )
        if entity is None and not query:
            raise TgError(
                "telegram: нужен текст запроса или --chat (пустой глобальный поиск запрещён)"
            )

        want_sender_id = None
        if global_from and sender is not None:  # sender гарантирован, `is not None` — для типов
            want_sender_id = await client.get_peer_id(sender)
        # server-side from_user — только в пределах чата; глобально передавать нельзя.
        iter_from = None if global_from else sender
        # при клиентском фильтре тянем с запасом: `limit` — про совпавших, не про скан.
        fetch_limit = _GLOBAL_FROM_SCAN_LIMIT if global_from else limit

        # search="" эквивалентно None: telethon всё равно уходит в messages.search с q=''
        # (q = search or '') — поведение «все сообщения». entity=None → searchGlobal.
        # Оба None валидны в рантайме, но стаб типизирует их как non-optional EntityLike —
        # точечно подавляем ложный reportArgumentType.
        try:
            messages = client.iter_messages(
                entity,  # pyright: ignore[reportArgumentType]
                limit=fetch_limit,
                search=query,
                from_user=iter_from,  # pyright: ignore[reportArgumentType]
            )
            async for msg in messages:
                if global_from and getattr(msg, "sender_id", None) != want_sender_id:
                    continue
                out.append(_message_from_telethon(msg))
                if global_from and len(out) >= limit:
                    break
        except FloodWaitError as e:
            raise TgError(f"telegram: rate-limit, подожди {e.seconds}s") from None
        except RPCError as e:
            raise TgError(f"telegram: RPC error: {e}") from None
    finally:
        await _disconnect(client)
    return out


async def interactive_login(
    cfg: TgConfig,
    *,
    phone: str,
    prompt_code: Callable[[], str],
    prompt_password: Callable[[], str],
) -> str:
    """Интерактивный вход: телефон → код → опц. 2FA. Возвращает строку StringSession.

    Колбэки ввода (`prompt_code` / `prompt_password`) передаются снаружи — модуль не
    привязан к terminal-вводу и тестируем. Уже авторизованная сессия отдаётся как есть.
    """
    from telethon.errors import (
        FloodWaitError,
        PhoneCodeExpiredError,
        PhoneCodeInvalidError,
        RPCError,
        SessionPasswordNeededError,
    )

    # Ввод кода/пароля — блокирующий (readline). Гонять его НАДО в executor: синхронный
    # ввод прямо в event loop заморозит фоновые задачи telethon (keepalive), Telegram закроет
    # соединение и sign_in уйдёт в бесконечный реконнект ("Server closed the connection").
    loop = asyncio.get_running_loop()
    client = _make_client(cfg)
    try:
        await client.connect()
        if await client.is_user_authorized():
            return _save_session(client)
        try:
            await client.send_code_request(phone)
        except FloodWaitError as e:
            raise TgError(f"telegram: rate-limit на отправку кода, подожди {e.seconds}s") from None
        code = await loop.run_in_executor(None, prompt_code)
        try:
            await client.sign_in(phone=phone, code=code)
        except SessionPasswordNeededError:
            password = await loop.run_in_executor(None, prompt_password)
            await client.sign_in(password=password)
        except PhoneCodeInvalidError:
            raise TgError("telegram: неверный код подтверждения") from None
        except PhoneCodeExpiredError:
            raise TgError("telegram: код подтверждения истёк, повтори вход") from None
        except RPCError as e:
            raise TgError(f"telegram: RPC error при входе: {e}") from None
        return _save_session(client)
    finally:
        await _disconnect(client)


def _display_name(entity: object) -> str:
    """Человекочитаемое имя сущности (чат/канал/пользователь). Пусто → "".

    title (чат/канал) → имя+фамилия (пользователь) → username → "".
    """
    title = getattr(entity, "title", None)
    if isinstance(title, str) and title:
        return title
    first = getattr(entity, "first_name", None) or ""
    last = getattr(entity, "last_name", None) or ""
    name = f"{first} {last}".strip()
    if name:
        return name
    username = getattr(entity, "username", None)
    return username if isinstance(username, str) else ""


def _message_from_telethon(msg: object) -> TgMessage:
    """Telethon Message → TgMessage. Атрибуты читаем через getattr (тип неизвестен pyright).

    `chat`/`sender` — кэш-проперти telethon (без сети; заполнены из ответа поиска); если
    Telegram их не вернул, деградируем мягко (chat_title="" / sender=None).
    """
    message_id = int(getattr(msg, "id", 0))
    chat = getattr(msg, "chat", None)
    sender = getattr(msg, "sender", None)
    chat_id_raw = getattr(msg, "chat_id", None)
    chat_id = int(chat_id_raw) if chat_id_raw is not None else 0
    username = getattr(chat, "username", None)
    date = getattr(msg, "date", None)
    text = getattr(msg, "message", None)
    sender_name = _display_name(sender) if sender is not None else ""
    return TgMessage(
        id=message_id,
        chat_id=chat_id,
        chat_title=_display_name(chat) if chat is not None else "",
        sender=sender_name or None,
        date=date.isoformat() if date is not None else None,
        text=text if isinstance(text, str) else "",
        link=message_link(chat_id, message_id, username if isinstance(username, str) else None),
    )


def _dialog_from_telethon(dialog: object) -> TgDialog:
    """Telethon Dialog → TgDialog. Атрибуты читаем через getattr (тип неизвестен pyright)."""
    entity = getattr(dialog, "entity", None)
    if getattr(dialog, "is_user", False):
        kind = "bot" if getattr(entity, "bot", False) else "user"
    elif getattr(dialog, "is_group", False):
        kind = "group"
    elif getattr(dialog, "is_channel", False):
        kind = "channel"
    else:
        kind = "unknown"
    username = getattr(entity, "username", None)
    return TgDialog(
        id=int(getattr(dialog, "id", 0)),
        title=str(getattr(dialog, "name", None) or ""),
        kind=kind,
        username=username if isinstance(username, str) else None,
    )


def _entity_to_dialog(entity: object) -> TgDialog:
    """Telethon User/Chat/Channel (из поиска) → TgDialog. Duck-typing по атрибутам.

    id маркируется по конвенции telethon (utils.get_peer_id): канал/супергруппа →
    `-(10^12 + id)`, базовая группа (Chat) → `-id`, пользователь → `id`.
    """
    raw_id = int(getattr(entity, "id", 0))
    username = getattr(entity, "username", None)
    has_title = getattr(entity, "title", None) is not None
    is_user = (
        getattr(entity, "first_name", None) is not None
        or getattr(entity, "last_name", None) is not None
    )
    if getattr(entity, "broadcast", False):
        kind, marked = "channel", -(1_000_000_000_000 + raw_id)
    elif getattr(entity, "megagroup", False):
        kind, marked = "group", -(1_000_000_000_000 + raw_id)
    elif has_title and not is_user:
        kind, marked = "group", -raw_id  # базовая группа (Chat)
    elif getattr(entity, "bot", False):
        kind, marked = "bot", raw_id
    else:
        kind, marked = "user", raw_id

    title = getattr(entity, "title", None)
    if not title:
        first = getattr(entity, "first_name", None) or ""
        last = getattr(entity, "last_name", None) or ""
        title = f"{first} {last}".strip() or (username if isinstance(username, str) else "")
    return TgDialog(
        id=marked,
        title=str(title),
        kind=kind,
        username=username if isinstance(username, str) else None,
    )
