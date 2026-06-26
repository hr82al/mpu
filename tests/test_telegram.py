"""Тесты `lib/telegram.py` (чистые функции) и `env.set_persistent` — без сети.

Сетевой telethon-I/O (send/ls/login) не покрываем, как и прочие клиенты в lib/.
"""

import asyncio
import os
import stat
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest

from mpu.lib import env, telegram
from mpu.lib.telegram import TgError


@pytest.fixture
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Изоляция os.environ + XDG_CONFIG_HOME на tmp; полный откат после теста."""
    saved = dict(os.environ)
    os.environ["XDG_CONFIG_HOME"] = str(tmp_path)
    monkeypatch.setattr(env, "_loaded", False)  # форсить перечитывание .env из tmp
    try:
        yield tmp_path
    finally:
        os.environ.clear()
        os.environ.update(saved)


# ── resolve_chat ─────────────────────────────────────────────────────────────


def test_resolve_chat_cli_wins() -> None:
    assert telegram.resolve_chat("@cli", "@env") == "@cli"


def test_resolve_chat_falls_back_to_env() -> None:
    assert telegram.resolve_chat(None, "@env") == "@env"


def test_resolve_chat_strips() -> None:
    assert telegram.resolve_chat("  @cli  ", None) == "@cli"


def test_resolve_chat_both_empty_raises() -> None:
    with pytest.raises(TgError):
        telegram.resolve_chat(None, None)
    with pytest.raises(TgError):
        telegram.resolve_chat("   ", "")


# ── parse_chat_target ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("123", 123),
        ("-100123456", -100123456),
        ("@user", "user"),
        ("user", "user"),
        ("me", "me"),
        ("+79991234567", "+79991234567"),
        ("https://t.me/some_channel", "some_channel"),
        ("http://t.me/some_channel", "some_channel"),
        ("t.me/some_channel/", "some_channel"),
        ("  42  ", 42),
    ],
)
def test_parse_chat_target(raw: str, expected: str | int) -> None:
    assert telegram.parse_chat_target(raw) == expected


def test_parse_chat_target_int_type() -> None:
    # числовой id → int, не строка
    assert isinstance(telegram.parse_chat_target("777"), int)
    assert isinstance(telegram.parse_chat_target("@777"), str)


# ── dialog_to_dict ───────────────────────────────────────────────────────────


def test_dialog_to_dict_shape() -> None:
    d = telegram.TgDialog(id=42, title="Чат", kind="group", username=None)
    assert telegram.dialog_to_dict(d) == {
        "id": 42,
        "title": "Чат",
        "kind": "group",
        "username": None,
    }


# ── message_link ─────────────────────────────────────────────────────────────


def test_message_link_public_username() -> None:
    assert telegram.message_link(-100123, 7, "devchat") == "https://t.me/devchat/7"


def test_message_link_private_channel_uses_raw_id() -> None:
    # marked id супергруппы/канала: -(10^12 + raw) → ссылка /c/<raw>/<msg>
    assert telegram.message_link(-(1_000_000_000_000 + 555), 9, None) == "https://t.me/c/555/9"


def test_message_link_user_dialog_none() -> None:
    assert telegram.message_link(42, 9, None) is None  # личный диалог — нет публичной ссылки
    assert telegram.message_link(-42, 9, None) is None  # базовая группа (Chat) — тоже нет


# ── message_to_dict ──────────────────────────────────────────────────────────


def test_message_to_dict_shape() -> None:
    m = telegram.TgMessage(
        id=1,
        chat_id=-100777,
        chat_title="Dev",
        sender="Иван",
        date="2026-06-18T10:00:00+00:00",
        text="залил не в ту ветку",
        link="https://t.me/c/777/1",
    )
    assert telegram.message_to_dict(m) == {
        "id": 1,
        "chat_id": -100777,
        "chat_title": "Dev",
        "sender": "Иван",
        "date": "2026-06-18T10:00:00+00:00",
        "text": "залил не в ту ветку",
        "link": "https://t.me/c/777/1",
    }


# ── parse_proxy_url / resolve_proxy ──────────────────────────────────────────


def test_parse_proxy_none_empty() -> None:
    assert telegram.parse_proxy_url(None) is None
    assert telegram.parse_proxy_url("") is None
    assert telegram.parse_proxy_url("   ") is None


def test_parse_proxy_http() -> None:
    assert telegram.parse_proxy_url("http://10.0.0.1:3128") == {
        "proxy_type": "http",
        "addr": "10.0.0.1",
        "port": 3128,
        "rdns": True,
        "username": None,
        "password": None,
    }


def test_parse_proxy_https_maps_to_http() -> None:
    proxy = telegram.parse_proxy_url("https://proxy.local:8080")
    assert proxy is not None
    assert proxy["proxy_type"] == "http"
    assert proxy["port"] == 8080


def test_parse_proxy_socks5_with_creds_percent_decoded() -> None:
    proxy = telegram.parse_proxy_url("socks5://user:p%40ss@h.local:1080")
    assert proxy is not None
    assert proxy["proxy_type"] == "socks5"
    assert proxy["username"] == "user"
    assert proxy["password"] == "p@ss"


def test_parse_proxy_socks_aliases() -> None:
    socks5 = telegram.parse_proxy_url("socks5h://h:1080")
    socks4 = telegram.parse_proxy_url("socks4a://h:1080")
    assert socks5 is not None and socks5["proxy_type"] == "socks5"
    assert socks4 is not None and socks4["proxy_type"] == "socks4"


def test_parse_proxy_unknown_scheme_raises() -> None:
    with pytest.raises(TgError):
        telegram.parse_proxy_url("ftp://h:21")


def test_parse_proxy_missing_port_raises() -> None:
    with pytest.raises(TgError):
        telegram.parse_proxy_url("http://hostonly")


def test_resolve_proxy_reads_telegram_proxy(isolated_env: Path) -> None:
    os.environ["TELEGRAM_PROXY"] = "http://h:3128"
    proxy = telegram.resolve_proxy()
    assert proxy is not None
    assert proxy["addr"] == "h"


def test_resolve_proxy_telegram_proxy_wins_over_https_proxy(isolated_env: Path) -> None:
    os.environ["TELEGRAM_PROXY"] = "socks5://tg:1080"
    os.environ["HTTPS_PROXY"] = "http://sys:3128"
    proxy = telegram.resolve_proxy()
    assert proxy is not None
    assert proxy["addr"] == "tg"


def test_resolve_proxy_falls_back_to_https_proxy(isolated_env: Path) -> None:
    os.environ.pop("TELEGRAM_PROXY", None)
    os.environ["HTTPS_PROXY"] = "http://h:3128"
    proxy = telegram.resolve_proxy()
    assert proxy is not None
    assert proxy["addr"] == "h"


def test_resolve_proxy_falls_back_to_lowercase(isolated_env: Path) -> None:
    os.environ.pop("TELEGRAM_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    os.environ["https_proxy"] = "socks5://h:1080"
    proxy = telegram.resolve_proxy()
    assert proxy is not None
    assert proxy["proxy_type"] == "socks5"


def test_resolve_proxy_none_when_unset(isolated_env: Path) -> None:
    os.environ.pop("TELEGRAM_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    os.environ.pop("https_proxy", None)
    assert telegram.resolve_proxy() is None


# ── TgConfig.from_env ────────────────────────────────────────────────────────


def test_from_env_ok(isolated_env: Path) -> None:
    os.environ["TELEGRAM_API_ID"] = "12345"
    os.environ["TELEGRAM_API_HASH"] = "abcdef"
    os.environ["TELEGRAM_SESSION"] = "sess"
    cfg = telegram.TgConfig.from_env()
    assert cfg.api_id == 12345
    assert cfg.api_hash == "abcdef"
    assert cfg.session == "sess"


def test_from_env_missing_creds_raises(isolated_env: Path) -> None:
    os.environ.pop("TELEGRAM_API_ID", None)
    os.environ.pop("TELEGRAM_API_HASH", None)
    with pytest.raises(TgError):
        telegram.TgConfig.from_env()


def test_from_env_non_int_api_id_raises(isolated_env: Path) -> None:
    os.environ["TELEGRAM_API_ID"] = "not-a-number"
    os.environ["TELEGRAM_API_HASH"] = "abcdef"
    with pytest.raises(TgError):
        telegram.TgConfig.from_env()


# ── env.set_persistent ───────────────────────────────────────────────────────


def _env_file(tmp_path: Path) -> Path:
    return tmp_path / "mpu" / ".env"


def test_set_persistent_appends_to_new_file(isolated_env: Path) -> None:
    env.set_persistent("TELEGRAM_SESSION", "1AbC+/d==")
    text = _env_file(isolated_env).read_text(encoding="utf-8")
    # base64-значение без спецсимволов → без кавычек
    assert "TELEGRAM_SESSION=1AbC+/d==" in text
    assert os.environ["TELEGRAM_SESSION"] == "1AbC+/d=="


def test_set_persistent_replaces_preserving_others(isolated_env: Path) -> None:
    path = _env_file(isolated_env)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# comment\nFOO=1\nexport TELEGRAM_SESSION=old\nBAR='x'\n", encoding="utf-8")
    env.set_persistent("TELEGRAM_SESSION", "new")
    lines = path.read_text(encoding="utf-8").splitlines()
    assert "# comment" in lines
    assert "FOO=1" in lines
    assert "BAR='x'" in lines
    assert "TELEGRAM_SESSION=new" in lines
    assert "export TELEGRAM_SESSION=old" not in lines
    # ровно одна строка про сессию
    assert sum(1 for ln in lines if ln.startswith("TELEGRAM_SESSION=")) == 1


def test_set_persistent_quotes_values_with_spaces(isolated_env: Path) -> None:
    env.set_persistent("X", "a b")
    assert "X='a b'" in _env_file(isolated_env).read_text(encoding="utf-8")


def test_set_persistent_perms_0600(isolated_env: Path) -> None:
    env.set_persistent("TELEGRAM_SESSION", "s")
    mode = stat.S_IMODE(_env_file(isolated_env).stat().st_mode)
    assert mode == 0o600


def test_set_persistent_rejects_newline(isolated_env: Path) -> None:
    with pytest.raises(ValueError):
        env.set_persistent("X", "a\nb")


# ── interactive_login (фейковый клиент, без сети) ─────────────────────────────


class _FakeSession:
    def save(self) -> str:
        return "SESSION_STR"


class _FakeClient:
    """Минимальный async-стаб telethon-клиента для проверки оркестрации login."""

    def __init__(self) -> None:
        self.session = _FakeSession()
        self.code_phone: str | None = None
        self.signed: tuple[object, object, object] | None = None

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return False

    async def send_code_request(self, phone: str) -> None:
        self.code_phone = phone

    async def sign_in(
        self, phone: object = None, code: object = None, password: object = None
    ) -> None:
        self.signed = (phone, code, password)

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_interactive_login_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """connect → send_code → ввод кода (через executor) → sign_in → строка сессии."""
    fake = _FakeClient()

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)
    code_calls: list[str] = []

    def prompt_code() -> str:
        code_calls.append("called")
        return "54321"

    result = asyncio.run(
        telegram.interactive_login(
            telegram.TgConfig(api_id=1, api_hash="h", session=None),
            phone="+79990000000",
            prompt_code=prompt_code,
            prompt_password=lambda: "pw",
        )
    )
    assert result == "SESSION_STR"
    assert code_calls == ["called"]
    assert fake.code_phone == "+79990000000"
    assert fake.signed == ("+79990000000", "54321", None)


# ── search_entities (фейковый клиент; косвенно проверяет _entity_to_dialog) ───


class _FakeSearchClient:
    """Async-стаб: __call__(SearchRequest) → объект с .users / .chats."""

    def __init__(self, users: list[object], chats: list[object]) -> None:
        self.session = _FakeSession()
        self._users = users
        self._chats = chats

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return True

    async def __call__(self, _request: object) -> object:
        return SimpleNamespace(users=self._users, chats=self._chats)

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_search_entities_finds_user_and_channel(monkeypatch: pytest.MonkeyPatch) -> None:
    users: list[object] = [
        SimpleNamespace(id=42, first_name="Иван", last_name="Изран", username="izran", bot=False)
    ]
    chats: list[object] = [
        SimpleNamespace(id=100, broadcast=True, megagroup=False, title="News", username="news")
    ]
    fake = _FakeSearchClient(users, chats)

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeSearchClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)
    res = asyncio.run(
        telegram.search_entities(
            telegram.TgConfig(api_id=1, api_hash="h", session=None), "Изран", 50
        )
    )
    by_kind = {d.kind: d for d in res}
    assert by_kind["user"].id == 42
    assert by_kind["user"].username == "izran"
    assert by_kind["user"].title == "Иван Изран"
    assert by_kind["channel"].id == -(1_000_000_000_000 + 100)
    assert by_kind["channel"].username == "news"


# ── search_messages (фейковый клиент; косвенно проверяет _message_from_telethon) ─


class _FakeMessagesClient:
    """Async-стаб: iter_messages(entity, search=, from_user=, limit=) → async-итератор Message."""

    def __init__(self, messages: list[object], peer_id: int = 0) -> None:
        self.session = _FakeSession()
        self._messages = messages
        self._peer_id = peer_id
        self.iter_kwargs: dict[str, object] = {}
        self.iter_entity: object = "UNSET"

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return True

    async def get_input_entity(self, target: object) -> object:
        return ("input", target)

    async def get_peer_id(self, _entity: object) -> int:
        return self._peer_id

    def iter_messages(self, entity: object, **kwargs: object) -> object:
        self.iter_entity = entity
        self.iter_kwargs = kwargs
        messages = self._messages

        async def _gen() -> object:
            for m in messages:
                yield m

        return _gen()

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_search_messages_global_maps_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    msg = SimpleNamespace(
        id=7,
        chat_id=-(1_000_000_000_000 + 999),
        message="ты залил не в ту ветку",
        date=SimpleNamespace(isoformat=lambda: "2026-06-18T10:00:00+00:00"),
        chat=SimpleNamespace(title="Dev chat", username=None),
        sender=SimpleNamespace(first_name="Иван", last_name="П", username="ivan"),
    )
    fake = _FakeMessagesClient([msg])

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeMessagesClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)
    res = asyncio.run(
        telegram.search_messages(
            telegram.TgConfig(api_id=1, api_hash="h", session=None),
            "ветку",
            chat=None,
            from_user=None,
            limit=50,
        )
    )
    assert fake.iter_entity is None  # глобальный поиск
    assert fake.iter_kwargs == {"search": "ветку", "limit": 50, "from_user": None}
    assert len(res) == 1
    m = res[0]
    assert m.id == 7
    assert m.chat_title == "Dev chat"
    assert m.sender == "Иван П"
    assert m.text == "ты залил не в ту ветку"
    assert m.date == "2026-06-18T10:00:00+00:00"
    assert m.link == "https://t.me/c/999/7"  # супергруппа без username → /c/<raw>


def test_search_messages_empty_query_no_scope_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMessagesClient([])

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeMessagesClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)
    with pytest.raises(TgError):  # пустой запрос без --chat = глобальный дамп, запрещён
        asyncio.run(
            telegram.search_messages(
                telegram.TgConfig(api_id=1, api_hash="h", session=None),
                "",
                chat=None,
                from_user=None,
                limit=50,
            )
        )


def _fake_msg(msg_id: int, sender_id: int, text: str) -> object:
    return SimpleNamespace(
        id=msg_id,
        chat_id=-(1_000_000_000_000 + 1),
        sender_id=sender_id,
        message=text,
        date=SimpleNamespace(isoformat=lambda: "2026-06-18T10:00:00+00:00"),
        chat=SimpleNamespace(title="Some chat", username=None),
        sender=SimpleNamespace(first_name="X", last_name="", username=None),
    )


def test_search_messages_global_from_filters_client_side(monkeypatch: pytest.MonkeyPatch) -> None:
    # глобальный from-фильтр: telethon не умеет → фильтруем по sender_id клиентски.
    wanted = 555
    msgs = [
        _fake_msg(1, 111, "чужое"),
        _fake_msg(2, wanted, "залил не в ту ветку"),
        _fake_msg(3, 222, "ещё чужое"),
    ]
    fake = _FakeMessagesClient(msgs, peer_id=wanted)

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeMessagesClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)

    res = asyncio.run(
        telegram.search_messages(
            telegram.TgConfig(api_id=1, api_hash="h", session=None),
            "ветку",
            chat=None,
            from_user="cicadaaaa",
            limit=50,
        )
    )
    assert fake.iter_entity is None  # глобальный поиск
    assert fake.iter_kwargs["from_user"] is None  # серверный from НЕ передаём при глобальном
    assert [m.id for m in res] == [2]  # только сообщение от нужного отправителя
    assert res[0].text == "залил не в ту ветку"


def test_search_messages_global_from_without_query_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMessagesClient([], peer_id=555)

    def _fake_make_client(_cfg: telegram.TgConfig) -> _FakeMessagesClient:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)
    with pytest.raises(TgError):  # глобальный from без текста — нечего сканировать
        asyncio.run(
            telegram.search_messages(
                telegram.TgConfig(api_id=1, api_hash="h", session=None),
                "",
                chat=None,
                from_user="cicadaaaa",
                limit=50,
            )
        )


# ── telegram status: _truncate + dry-run (локальный журнал, без сети) ────────────


def test_truncate_status_message() -> None:
    from mpu.commands.telegram import _truncate  # pyright: ignore[reportPrivateUsage]

    assert _truncate("короткий", 100) == "короткий"
    out = _truncate("x" * 5000, 100)
    assert len(out) <= 100
    assert out.endswith("…(обрезано)")


def test_status_dry_run_local_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from typer.testing import CliRunner

    from mpu.commands import telegram as telegram_cmd
    from mpu.lib import kaiten_links, kiten_status, store

    db = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db)
    since, _until = kiten_status.today_epoch_window()
    with store.store(db) as conn:
        store.bootstrap(conn)
        kaiten_links.record_move(
            conn,
            111,
            to_column="Готово",
            title="Моя карточка",
            url="https://btlz.kaiten.ru/111",
            now=since + 60,
        )
    result = CliRunner().invoke(telegram_cmd.app, ["status", "--dry-run", "--no-live"])
    assert result.exit_code == 0, result.output
    assert "[Моя карточка](https://btlz.kaiten.ru/111)" in result.output
    assert "✅" in result.output


# ── async I/O: общие хелперы для фейкового клиента ─────────────────────────────


def _make_cfg() -> telegram.TgConfig:
    return telegram.TgConfig(api_id=1, api_hash="h", session=None)


def _iso(value: str = "2026-06-18T10:00:00+00:00") -> object:
    return SimpleNamespace(isoformat=lambda: value)


def _patch_client(monkeypatch: pytest.MonkeyPatch, fake: object) -> None:
    """Подменить _make_client так, чтобы I/O-функции получили наш фейк вместо telethon."""

    def _fake_make_client(_cfg: telegram.TgConfig) -> object:
        return fake

    monkeypatch.setattr(telegram, "_make_client", _fake_make_client)


def _flood_error(seconds: int = 7) -> Exception:
    from telethon.errors import FloodWaitError  # pyright: ignore[reportMissingTypeStubs]

    return FloodWaitError(request=None, capture=seconds)


def _rpc_error() -> Exception:
    from telethon.errors import RPCError  # pyright: ignore[reportMissingTypeStubs]

    return RPCError(request=None, message="boom", code=400)


# ── send_message ─────────────────────────────────────────────────────────────


class _FakeSendClient:
    """Async-стаб клиента для send_message: connect/auth/send/disconnect, запись аргументов."""

    def __init__(
        self,
        *,
        authorized: bool = True,
        send_result: object = None,
        send_error: Exception | None = None,
        disconnect_none: bool = False,
    ) -> None:
        self.session = _FakeSession()
        self._authorized = authorized
        self._send_result = send_result
        self._send_error = send_error
        self._disconnect_none = disconnect_none
        self.sent: tuple[object, object, object] | None = None
        self.sent_file: tuple[object, object, object, object, object] | None = None

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return self._authorized

    async def send_message(
        self, target: object, text: object, *, parse_mode: object = None
    ) -> object:
        self.sent = (target, text, parse_mode)
        if self._send_error is not None:
            raise self._send_error
        return self._send_result

    async def send_file(
        self,
        target: object,
        file: object,
        *,
        caption: object = None,
        parse_mode: object = None,
        force_document: object = None,
    ) -> object:
        self.sent_file = (target, file, caption, parse_mode, force_document)
        if self._send_error is not None:
            raise self._send_error
        return self._send_result

    def disconnect(self) -> object:
        if self._disconnect_none:
            return None  # покрывает ветку _disconnect, где закрывать нечего

        async def _noop() -> None:
            return None

        return _noop()


def test_send_message_via_real_make_client(
    isolated_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """send_message строит клиент через НАСТОЯЩИЙ _make_client (telethon-классы замоканы)."""
    os.environ["TELEGRAM_PROXY"] = "socks5://proxy.local:1080"
    captured: dict[str, object] = {}

    class _StubSession:
        def __init__(self, value: str) -> None:
            captured["session_value"] = value

    fake = _FakeSendClient(send_result=SimpleNamespace(id=10, date=_iso(), chat_id=-100777))

    def _stub_client(
        session: object, api_id: object, api_hash: object, *, proxy: object = None
    ) -> _FakeSendClient:
        captured["client_args"] = (api_id, api_hash, proxy)
        return fake

    monkeypatch.setattr("telethon.sessions.StringSession", _StubSession)
    monkeypatch.setattr("telethon.TelegramClient", _stub_client)

    res = asyncio.run(
        telegram.send_message(
            telegram.TgConfig(api_id=99, api_hash="hh", session="SESS"), "@dev", "привет"
        )
    )
    assert captured["session_value"] == "SESS"
    assert captured["client_args"] == (
        99,
        "hh",
        {
            "proxy_type": "socks5",
            "addr": "proxy.local",
            "port": 1080,
            "rdns": True,
            "username": None,
            "password": None,
        },
    )
    assert fake.sent == ("@dev", "привет", None)
    assert res.id == 10
    assert res.chat_id == -100777
    assert res.date == "2026-06-18T10:00:00+00:00"


def test_send_message_null_date_and_chat_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Telegram не вернул date/chat_id → date=None, chat_id=0; disconnect без coroutine."""
    fake = _FakeSendClient(
        send_result=SimpleNamespace(id=3, date=None, chat_id=None), disconnect_none=True
    )
    _patch_client(monkeypatch, fake)
    res = asyncio.run(telegram.send_message(_make_cfg(), 12345, "hi", parse_mode="md"))
    assert res.id == 3
    assert res.chat_id == 0
    assert res.date is None
    assert fake.sent == (12345, "hi", "md")


def test_send_message_not_authorized_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(authorized=False)
    _patch_client(monkeypatch, fake)
    with pytest.raises(telegram.TgNotAuthorizedError):
        asyncio.run(telegram.send_message(_make_cfg(), "@dev", "hi"))
    assert fake.sent is None  # до отправки не дошли


def test_send_message_value_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=ValueError("no such chat"))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.send_message(_make_cfg(), "@ghost", "hi"))


def test_send_message_flood_wait_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=_flood_error(30))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError) as excinfo:
        asyncio.run(telegram.send_message(_make_cfg(), "@dev", "hi"))
    assert "30s" in str(excinfo.value)


def test_send_message_rpc_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=_rpc_error())
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.send_message(_make_cfg(), "@dev", "hi"))


# ── send_file ────────────────────────────────────────────────────────────────


def test_send_file_single_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Один путь → отправка документом (force_document=True), метаданные из Message."""
    fake = _FakeSendClient(send_result=SimpleNamespace(id=42, date=_iso(), chat_id=-100500))
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.send_file(_make_cfg(), "me", ["/tmp/a.zip"], caption="hi", parse_mode="md")
    )
    assert fake.sent_file == ("me", ["/tmp/a.zip"], "hi", "md", True)
    assert res.id == 42
    assert res.chat_id == -100500
    assert res.date == "2026-06-18T10:00:00+00:00"


def test_send_file_list_result_takes_last(monkeypatch: pytest.MonkeyPatch) -> None:
    """Альбом → telethon отдаёт list[Message]; берём последнее (тут date/chat_id пусты)."""
    first = SimpleNamespace(id=1, date=_iso(), chat_id=-1)
    last = SimpleNamespace(id=2, date=None, chat_id=None)
    fake = _FakeSendClient(send_result=[first, last])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(telegram.send_file(_make_cfg(), 7, ["/tmp/a", "/tmp/b"]))
    assert res.id == 2
    assert res.chat_id == 0
    assert res.date is None


def test_send_file_not_authorized_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(authorized=False)
    _patch_client(monkeypatch, fake)
    with pytest.raises(telegram.TgNotAuthorizedError):
        asyncio.run(telegram.send_file(_make_cfg(), "me", ["/tmp/a"]))
    assert fake.sent_file is None  # до отправки не дошли


def test_send_file_value_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=ValueError("no such chat"))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.send_file(_make_cfg(), "@ghost", ["/tmp/a"]))


def test_send_file_flood_wait_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=_flood_error(15))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError) as excinfo:
        asyncio.run(telegram.send_file(_make_cfg(), "me", ["/tmp/a"]))
    assert "15s" in str(excinfo.value)


def test_send_file_rpc_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeSendClient(send_error=_rpc_error())
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.send_file(_make_cfg(), "me", ["/tmp/a"]))


# ── list_dialogs ─────────────────────────────────────────────────────────────


class _FakeDialogsClient:
    """Async-стаб: iter_dialogs(limit=) → async-итератор Dialog (или ошибка)."""

    def __init__(self, dialogs: list[object], *, error: Exception | None = None) -> None:
        self.session = _FakeSession()
        self._dialogs = dialogs
        self._error = error
        self.iter_limit: int | None = None

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return True

    def iter_dialogs(self, *, limit: int) -> object:
        self.iter_limit = limit
        dialogs = self._dialogs
        error = self._error

        async def _gen() -> object:
            if error is not None:
                raise error
            for d in dialogs:
                yield d

        return _gen()

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_list_dialogs_maps_all_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    dialogs: list[object] = [
        SimpleNamespace(
            is_user=True,
            is_group=False,
            is_channel=False,
            id=1,
            name="Alice",
            entity=SimpleNamespace(bot=False, username="alice"),
        ),
        SimpleNamespace(
            is_user=True,
            is_group=False,
            is_channel=False,
            id=2,
            name="Botty",
            entity=SimpleNamespace(bot=True, username=None),
        ),
        SimpleNamespace(
            is_user=False,
            is_group=True,
            is_channel=False,
            id=-5,
            name="Grp",
            entity=SimpleNamespace(username=None),
        ),
        SimpleNamespace(
            is_user=False,
            is_group=False,
            is_channel=True,
            id=-100,
            name="Chan",
            entity=SimpleNamespace(username="chan"),
        ),
        SimpleNamespace(
            is_user=False, is_group=False, is_channel=False, id=0, name=None, entity=None
        ),
    ]
    fake = _FakeDialogsClient(dialogs)
    _patch_client(monkeypatch, fake)
    res = asyncio.run(telegram.list_dialogs(_make_cfg(), 25))
    assert fake.iter_limit == 25
    by_id = {d.id: d for d in res}
    assert by_id[1].kind == "user" and by_id[1].username == "alice"
    assert by_id[2].kind == "bot" and by_id[2].username is None and by_id[2].title == "Botty"
    assert by_id[-5].kind == "group"
    assert by_id[-100].kind == "channel" and by_id[-100].username == "chan"
    assert by_id[0].kind == "unknown" and by_id[0].title == ""


def test_list_dialogs_flood_wait_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeDialogsClient([], error=_flood_error(5))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.list_dialogs(_make_cfg(), 10))


def test_list_dialogs_rpc_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeDialogsClient([], error=_rpc_error())
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(telegram.list_dialogs(_make_cfg(), 10))


# ── search_entities (ошибки + остальные ветки _entity_to_dialog) ─────────────


class _FakeSearchErrClient:
    """Async-стаб поиска сущностей: __call__ всегда бросает заданную ошибку."""

    def __init__(self, error: Exception) -> None:
        self.session = _FakeSession()
        self._error = error

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return True

    async def __call__(self, _request: object) -> object:
        raise self._error

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_search_entities_flood_wait_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeSearchErrClient(_flood_error(9)))
    with pytest.raises(TgError):
        asyncio.run(telegram.search_entities(_make_cfg(), "x", 10))


def test_search_entities_rpc_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_client(monkeypatch, _FakeSearchErrClient(_rpc_error()))
    with pytest.raises(TgError):
        asyncio.run(telegram.search_entities(_make_cfg(), "x", 10))


def test_search_entities_kinds_and_dedup(monkeypatch: pytest.MonkeyPatch) -> None:
    """megagroup → group, Chat-с-title → group, bot → bot, username-only → user; дедуп по id."""
    users: list[object] = [
        SimpleNamespace(id=42, first_name="A", username="dup"),
        SimpleNamespace(id=42, first_name="B", username="dup"),  # дубль того же id
        SimpleNamespace(id=400, first_name="Botty", bot=True, username="bot"),
        SimpleNamespace(id=500, username="ghost"),  # ни title, ни имени → title из username
    ]
    chats: list[object] = [
        SimpleNamespace(id=200, broadcast=False, megagroup=True, title="MG", username="mg"),
        SimpleNamespace(id=300, title="BG", username=None),  # базовая группа (Chat)
    ]
    _patch_client(monkeypatch, _FakeSearchClient(users, chats))
    res = asyncio.run(telegram.search_entities(_make_cfg(), "q", 50))
    by_id = {d.id: d for d in res}
    assert sum(1 for d in res if d.id == 42) == 1  # дедуп
    assert by_id[42].kind == "user"
    assert by_id[400].kind == "bot"
    assert by_id[500].kind == "user" and by_id[500].title == "ghost"
    assert by_id[-(1_000_000_000_000 + 200)].kind == "group"  # megagroup
    assert by_id[-300].kind == "group" and by_id[-300].title == "BG"  # базовая группа


# ── search_messages (scope/from-ветки, ошибки, деградация полей) ─────────────


class _FakeMsgSearchClient:
    """Async-стаб: get_input_entity/get_peer_id/iter_messages с настраиваемыми ошибками."""

    def __init__(
        self,
        messages: list[object],
        *,
        peer_id: int = 0,
        bad_targets: tuple[object, ...] = (),
        iter_error: Exception | None = None,
    ) -> None:
        self.session = _FakeSession()
        self._messages = messages
        self._peer_id = peer_id
        self._bad_targets: set[object] = set(bad_targets)
        self._iter_error = iter_error
        self.iter_kwargs: dict[str, object] = {}
        self.iter_entity: object = "UNSET"

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return True

    async def get_input_entity(self, target: object) -> object:
        if target in self._bad_targets:
            raise ValueError(f"no entity for {target!r}")
        return ("input", target)

    async def get_peer_id(self, _entity: object) -> int:
        return self._peer_id

    def iter_messages(self, entity: object, **kwargs: object) -> object:
        self.iter_entity = entity
        self.iter_kwargs = kwargs
        messages = self._messages
        error = self._iter_error

        async def _gen() -> object:
            if error is not None:
                raise error
            for m in messages:
                yield m

        return _gen()

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_search_messages_in_chat_passes_entity(monkeypatch: pytest.MonkeyPatch) -> None:
    msg = SimpleNamespace(
        id=1,
        chat_id=-100,
        message="hi",
        date=_iso(),
        chat=SimpleNamespace(title="C", username="cc"),
        sender=SimpleNamespace(first_name="X", last_name="Y", username="x"),
    )
    fake = _FakeMsgSearchClient([msg])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "hi", chat="@dev", from_user=None, limit=10)
    )
    assert fake.iter_entity == ("input", "@dev")  # поиск внутри чата
    assert fake.iter_kwargs == {"search": "hi", "limit": 10, "from_user": None}
    assert len(res) == 1
    assert res[0].link == "https://t.me/cc/1"  # публичный username → прямая ссылка


def test_search_messages_in_chat_server_side_from(monkeypatch: pytest.MonkeyPatch) -> None:
    """from внутри чата — серверный фильтр: sender передаётся в iter_messages."""
    fake = _FakeMsgSearchClient([])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "x", chat="@dev", from_user="@bob", limit=7)
    )
    assert fake.iter_entity == ("input", "@dev")
    assert fake.iter_kwargs["from_user"] == ("input", "@bob")  # серверный from
    assert fake.iter_kwargs["limit"] == 7
    assert res == []


def test_search_messages_empty_query_with_chat_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой query + chat → история чата без текстового фильтра (не запрещён)."""
    fake = _FakeMsgSearchClient([])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "", chat="@dev", from_user=None, limit=10)
    )
    assert fake.iter_entity == ("input", "@dev")
    assert fake.iter_kwargs["search"] == ""
    assert res == []


def test_search_messages_bad_chat_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMsgSearchClient([], bad_targets=("@bad",))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.search_messages(_make_cfg(), "x", chat="@bad", from_user=None, limit=10)
        )


def test_search_messages_bad_from_user_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMsgSearchClient([], bad_targets=("@baduser",))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.search_messages(_make_cfg(), "x", chat="@dev", from_user="@baduser", limit=10)
        )


def test_search_messages_flood_wait_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMsgSearchClient([], iter_error=_flood_error(3))
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.search_messages(_make_cfg(), "x", chat="@dev", from_user=None, limit=10)
        )


def test_search_messages_rpc_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeMsgSearchClient([], iter_error=_rpc_error())
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.search_messages(_make_cfg(), "x", chat="@dev", from_user=None, limit=10)
        )


def test_search_messages_degraded_message_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """Telegram отдал минимум — мягкая деградация (chat_title='', sender=None, text='')."""
    fake = _FakeMsgSearchClient([SimpleNamespace(id=5)])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "x", chat=None, from_user=None, limit=10)
    )
    assert fake.iter_entity is None  # глобальный поиск
    m = res[0]
    assert m.id == 5
    assert m.chat_id == 0
    assert m.chat_title == ""
    assert m.sender is None
    assert m.date is None
    assert m.text == ""
    assert m.link is None


def test_search_messages_global_from_stops_at_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Глобальный from: набрав limit совпадений по отправителю, прекращаем скан (break)."""
    wanted = 555
    msgs = [_fake_msg(1, wanted, "ветку one"), _fake_msg(2, wanted, "ветку two")]
    fake = _FakeMsgSearchClient(msgs, peer_id=wanted)
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "ветку", chat=None, from_user="@bob", limit=1)
    )
    assert [m.id for m in res] == [1]  # остановились на первом совпадении из-за limit=1


def test_search_messages_sender_username_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """sender без title/имени → отображаемое имя = username."""
    msg = SimpleNamespace(
        id=6,
        chat_id=-100,
        message="hey",
        date=_iso(),
        chat=SimpleNamespace(title="C", username=None),
        sender=SimpleNamespace(username="bob"),
    )
    fake = _FakeMsgSearchClient([msg])
    _patch_client(monkeypatch, fake)
    res = asyncio.run(
        telegram.search_messages(_make_cfg(), "hey", chat=None, from_user=None, limit=10)
    )
    assert res[0].sender == "bob"


# ── interactive_login (остальные ветки) ──────────────────────────────────────


def _password_needed_error() -> Exception:
    from telethon.errors import (  # pyright: ignore[reportMissingTypeStubs]
        SessionPasswordNeededError,
    )

    return SessionPasswordNeededError(request=None)


def _code_invalid_error() -> Exception:
    from telethon.errors import (  # pyright: ignore[reportMissingTypeStubs]
        PhoneCodeInvalidError,
    )

    return PhoneCodeInvalidError(request=None)


def _code_expired_error() -> Exception:
    from telethon.errors import (  # pyright: ignore[reportMissingTypeStubs]
        PhoneCodeExpiredError,
    )

    return PhoneCodeExpiredError(request=None)


class _FakeLoginClient:
    """Async-стаб login: настраиваемые авторизация/сессия/ошибки send_code и sign_in (очередь)."""

    def __init__(
        self,
        *,
        authorized: bool = False,
        session: _FakeSession | None = None,
        send_code_error: Exception | None = None,
        sign_in_errors: tuple[Exception, ...] = (),
    ) -> None:
        self.session = session
        self._authorized = authorized
        self._send_code_error = send_code_error
        self._sign_in_errors: list[Exception] = list(sign_in_errors)
        self.code_phone: str | None = None
        self.signed: list[tuple[object, object, object]] = []

    async def connect(self) -> None:
        pass

    async def is_user_authorized(self) -> bool:
        return self._authorized

    async def send_code_request(self, phone: str) -> None:
        self.code_phone = phone
        if self._send_code_error is not None:
            raise self._send_code_error

    async def sign_in(
        self, phone: object = None, code: object = None, password: object = None
    ) -> None:
        self.signed.append((phone, code, password))
        if self._sign_in_errors:
            raise self._sign_in_errors.pop(0)

    def disconnect(self) -> object:
        async def _noop() -> None:
            return None

        return _noop()


def test_interactive_login_already_authorized_returns_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeLoginClient(authorized=True, session=_FakeSession())
    _patch_client(monkeypatch, fake)
    result = asyncio.run(
        telegram.interactive_login(
            _make_cfg(),
            phone="+79990000000",
            prompt_code=lambda: "1",
            prompt_password=lambda: "p",
        )
    )
    assert result == "SESSION_STR"
    assert fake.code_phone is None  # код не запрашивали
    assert fake.signed == []


def test_interactive_login_already_authorized_no_session_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeLoginClient(authorized=True, session=None)
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.interactive_login(
                _make_cfg(),
                phone="+79990000000",
                prompt_code=lambda: "1",
                prompt_password=lambda: "p",
            )
        )


def test_interactive_login_send_code_flood_wait_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeLoginClient(
        authorized=False, session=_FakeSession(), send_code_error=_flood_error(60)
    )
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.interactive_login(
                _make_cfg(),
                phone="+79990000000",
                prompt_code=lambda: "1",
                prompt_password=lambda: "p",
            )
        )
    assert fake.signed == []  # до sign_in не дошли


def test_interactive_login_2fa_password_path(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeLoginClient(
        authorized=False, session=_FakeSession(), sign_in_errors=(_password_needed_error(),)
    )
    pw_calls: list[str] = []

    def prompt_password() -> str:
        pw_calls.append("called")
        return "secret"

    _patch_client(monkeypatch, fake)
    result = asyncio.run(
        telegram.interactive_login(
            _make_cfg(),
            phone="+79990000000",
            prompt_code=lambda: "11111",
            prompt_password=prompt_password,
        )
    )
    assert result == "SESSION_STR"
    assert pw_calls == ["called"]
    assert fake.signed[-1] == (None, None, "secret")  # повторный sign_in с паролем


def test_interactive_login_code_invalid_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeLoginClient(
        authorized=False, session=_FakeSession(), sign_in_errors=(_code_invalid_error(),)
    )
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.interactive_login(
                _make_cfg(),
                phone="+79990000000",
                prompt_code=lambda: "1",
                prompt_password=lambda: "p",
            )
        )


def test_interactive_login_code_expired_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeLoginClient(
        authorized=False, session=_FakeSession(), sign_in_errors=(_code_expired_error(),)
    )
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.interactive_login(
                _make_cfg(),
                phone="+79990000000",
                prompt_code=lambda: "1",
                prompt_password=lambda: "p",
            )
        )


def test_interactive_login_rpc_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeLoginClient(
        authorized=False, session=_FakeSession(), sign_in_errors=(_rpc_error(),)
    )
    _patch_client(monkeypatch, fake)
    with pytest.raises(TgError):
        asyncio.run(
            telegram.interactive_login(
                _make_cfg(),
                phone="+79990000000",
                prompt_code=lambda: "1",
                prompt_password=lambda: "p",
            )
        )
