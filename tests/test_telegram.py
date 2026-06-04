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
