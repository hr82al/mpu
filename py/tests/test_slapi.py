"""Тесты `lib/slapi.py` — sl-back HTTP клиент + кеш JWT-токена.

Сеть мокается через httpx.MockTransport: `slapi.request` создаёт `httpx.Client`
сам (без инъекции transport), поэтому подменяем `httpx.Client` фабрикой,
которая прокидывает MockTransport. Кеш токена пишется в `tmp_path`. TTL
контролируется подменой `slapi.time.time`.
"""
# pyright: reportPrivateUsage=false

import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest

from mpu.lib import env, slapi
from mpu.lib.slapi import (
    SlApi,
    SlApiError,
    TokenCacheEntry,
    clear_token_cache,
    read_token_cache,
    resolve_base_url,
    resolve_credentials,
    token_cache_path,
    write_token_cache,
)

# Захватываем настоящий httpx.Client ДО любой подмены — фабрика создаёт реальный
# клиент с MockTransport.
_REAL_HTTPX_CLIENT = httpx.Client

Handler = Callable[[httpx.Request], httpx.Response]


def _patch_transport(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> None:
    """Подменить httpx.Client так, чтобы все запросы шли в MockTransport."""
    transport = httpx.MockTransport(handler)

    def factory(*, timeout: float) -> httpx.Client:
        return _REAL_HTTPX_CLIENT(transport=transport, timeout=timeout)

    monkeypatch.setattr(httpx, "Client", factory)


def _api(cache_path: Path | None = None) -> SlApi:
    return SlApi(
        base_url="https://api.test/api",
        email="e@x",
        password="pw",
        cache_path=cache_path,
    )


def _write_cache(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _valid_cache(path: Path, token: str = "CACHED") -> None:
    _write_cache(path, {"token": token, "expires_at": time.time() + 10_000})


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Изолировать от реального ~/.config/mpu/.env: load() — no-op, env-vars чистые."""
    monkeypatch.setattr(env, "_loaded", True)
    for name in ("BASE_API_URL", "NEXT_PUBLIC_SERVER_URL", "TOKEN_EMAIL", "TOKEN_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    yield


# --------------------------------------------------------------------------- #
# token_cache_path / _xdg_config_home
# --------------------------------------------------------------------------- #


def test_token_cache_path_uses_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert token_cache_path() == tmp_path / "mpu" / ".api-token.json"


def test_token_cache_path_falls_back_to_home(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    assert token_cache_path() == Path.home() / ".config" / "mpu" / ".api-token.json"


# --------------------------------------------------------------------------- #
# _truncate / SlApiError
# --------------------------------------------------------------------------- #


def test_truncate_short_unchanged() -> None:
    assert slapi._truncate("abc", 10) == "abc"


def test_truncate_long_adds_suffix() -> None:
    out = slapi._truncate("abcdef", 3)
    assert out == "abc…(+3 bytes)"


def test_slapierror_carries_status_and_body() -> None:
    err = SlApiError("boom", status=503, body="oops")
    assert str(err) == "boom"
    assert err.status == 503
    assert err.body == "oops"


def test_slapierror_defaults_none() -> None:
    err = SlApiError("boom")
    assert err.status is None
    assert err.body is None


# --------------------------------------------------------------------------- #
# resolve_base_url
# --------------------------------------------------------------------------- #


def test_resolve_base_url_full_url_strips_slash(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BASE_API_URL", "https://mp.btlz-api.ru/api/")
    assert resolve_base_url() == "https://mp.btlz-api.ru/api"


def test_resolve_base_url_path_plus_host(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BASE_API_URL", "/api")
    monkeypatch.setenv("NEXT_PUBLIC_SERVER_URL", "https://host.ru/")
    assert resolve_base_url() == "https://host.ru/api"


def test_resolve_base_url_host_only(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXT_PUBLIC_SERVER_URL", "https://host.ru/")
    assert resolve_base_url() == "https://host.ru"


def test_resolve_base_url_missing_raises(clean_env: None) -> None:
    with pytest.raises(SlApiError) as ei:
        resolve_base_url()
    assert "base URL не задан" in str(ei.value)


# --------------------------------------------------------------------------- #
# resolve_credentials
# --------------------------------------------------------------------------- #


def test_resolve_credentials_ok(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TOKEN_EMAIL", "a@b.ru")
    monkeypatch.setenv("TOKEN_PASSWORD", "secret")
    assert resolve_credentials() == ("a@b.ru", "secret")


def test_resolve_credentials_missing_both(clean_env: None) -> None:
    with pytest.raises(SlApiError) as ei:
        resolve_credentials()
    msg = str(ei.value)
    assert "TOKEN_EMAIL" in msg
    assert "TOKEN_PASSWORD" in msg


def test_resolve_credentials_missing_one(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TOKEN_EMAIL", "a@b.ru")
    with pytest.raises(SlApiError) as ei:
        resolve_credentials()
    msg = str(ei.value)
    assert "TOKEN_PASSWORD" in msg
    assert "TOKEN_EMAIL" not in msg


# --------------------------------------------------------------------------- #
# TokenCacheEntry.is_valid
# --------------------------------------------------------------------------- #


def test_is_valid_with_explicit_now() -> None:
    entry = TokenCacheEntry(token="t", expires_at=100.0)
    assert entry.is_valid(now=50.0) is True
    assert entry.is_valid(now=150.0) is False
    assert entry.is_valid(now=100.0) is False  # граница: now == expires_at → невалиден


def test_is_valid_default_now_uses_time(monkeypatch: pytest.MonkeyPatch) -> None:
    entry = TokenCacheEntry(token="t", expires_at=1_000.0)
    monkeypatch.setattr(slapi.time, "time", lambda: 999.0)
    assert entry.is_valid() is True
    monkeypatch.setattr(slapi.time, "time", lambda: 1_001.0)
    assert entry.is_valid() is False


# --------------------------------------------------------------------------- #
# read_token_cache
# --------------------------------------------------------------------------- #


def test_read_token_cache_missing_file_returns_none(tmp_path: Path) -> None:
    assert read_token_cache(tmp_path / "nope.json") is None


def test_read_token_cache_invalid_json_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    p.write_text("{not json", encoding="utf-8")
    assert read_token_cache(p) is None


def test_read_token_cache_non_dict_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    _write_cache(p, [1, 2, 3])
    assert read_token_cache(p) is None


def test_read_token_cache_wrong_token_type_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    _write_cache(p, {"token": 123, "expires_at": time.time() + 100})
    assert read_token_cache(p) is None


def test_read_token_cache_wrong_expires_type_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    _write_cache(p, {"token": "abc", "expires_at": "soon"})
    assert read_token_cache(p) is None


def test_read_token_cache_expired_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    _write_cache(p, {"token": "abc", "expires_at": time.time() - 100})
    assert read_token_cache(p) is None


def test_read_token_cache_valid_returns_entry(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    _valid_cache(p, token="GOOD")
    entry = read_token_cache(p)
    assert entry is not None
    assert entry.token == "GOOD"


def test_read_token_cache_default_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """path=None → token_cache_path() (через XDG_CONFIG_HOME)."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    _valid_cache(token_cache_path(), token="DEF")
    entry = read_token_cache()
    assert entry is not None
    assert entry.token == "DEF"


# --------------------------------------------------------------------------- #
# write_token_cache
# --------------------------------------------------------------------------- #


def test_write_token_cache_writes_payload_and_ttl(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(slapi.time, "time", lambda: 1_000.0)
    p = tmp_path / "sub" / "tok.json"
    write_token_cache("TKN", ttl_seconds=600, path=p)
    data = json.loads(p.read_text(encoding="utf-8"))
    assert data == {"token": "TKN", "expires_at": 1_600.0}
    # tmp-файл не остался (атомарный replace).
    assert not (tmp_path / "sub" / "tok.json.tmp").exists()


def test_write_token_cache_sets_0600(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    write_token_cache("TKN", path=p)
    assert (p.stat().st_mode & 0o777) == 0o600


def test_write_then_read_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    write_token_cache("ROUND", ttl_seconds=600, path=p)
    entry = read_token_cache(p)
    assert entry is not None
    assert entry.token == "ROUND"


def test_write_token_cache_default_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    write_token_cache("DEF")
    assert token_cache_path().exists()


# --------------------------------------------------------------------------- #
# clear_token_cache
# --------------------------------------------------------------------------- #


def test_clear_token_cache_removes_existing(tmp_path: Path) -> None:
    p = tmp_path / "tok.json"
    p.write_text("{}", encoding="utf-8")
    assert clear_token_cache(p) is True
    assert not p.exists()


def test_clear_token_cache_missing_returns_false(tmp_path: Path) -> None:
    assert clear_token_cache(tmp_path / "nope.json") is False


# --------------------------------------------------------------------------- #
# SlApi.from_env
# --------------------------------------------------------------------------- #


def test_from_env_resolves(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BASE_API_URL", "https://mp.btlz-api.ru/api")
    monkeypatch.setenv("TOKEN_EMAIL", "a@b.ru")
    monkeypatch.setenv("TOKEN_PASSWORD", "secret")
    api = SlApi.from_env()
    assert api.base_url == "https://mp.btlz-api.ru/api"
    assert api.email == "a@b.ru"
    assert api.password == "secret"
    assert api.cache_path is None


def test_from_env_missing_creds_raises(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BASE_API_URL", "https://mp.btlz-api.ru/api")
    with pytest.raises(SlApiError):
        SlApi.from_env()


# --------------------------------------------------------------------------- #
# _build_url
# --------------------------------------------------------------------------- #


def test_build_url_adds_leading_slash() -> None:
    api = _api()
    assert api._build_url("v1/data", None) == "https://api.test/api/v1/data"


def test_build_url_keeps_leading_slash() -> None:
    api = _api()
    assert api._build_url("/v1/data", None) == "https://api.test/api/v1/data"


def test_build_url_appends_query_drops_none() -> None:
    api = _api()
    url = api._build_url("/v1/data", {"a": 1, "b": None, "c": "x"})
    assert url == "https://api.test/api/v1/data?a=1&c=x"


def test_build_url_all_none_query_no_separator() -> None:
    api = _api()
    assert api._build_url("/v1/data", {"a": None}) == "https://api.test/api/v1/data"


def test_build_url_empty_query_dict() -> None:
    api = _api()
    assert api._build_url("/v1/data", {}) == "https://api.test/api/v1/data"


def test_build_url_uses_amp_when_qmark_present() -> None:
    api = _api()
    url = api._build_url("/v1/data?existing=1", {"a": 2})
    assert url == "https://api.test/api/v1/data?existing=1&a=2"


# --------------------------------------------------------------------------- #
# SlApi.request
# --------------------------------------------------------------------------- #


def test_request_no_auth_omits_authorization(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["method"] = request.method
        captured["path"] = request.url.path
        return httpx.Response(200, json={"ok": True})

    _patch_transport(monkeypatch, handler)
    result = _api().request("GET", "/v1/ping", no_auth=True)
    assert result == {"ok": True}
    assert captured["auth"] is None
    assert captured["method"] == "GET"
    assert captured["path"] == "/api/v1/ping"


def test_request_authed_adds_bearer(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cache = tmp_path / "tok.json"
    _valid_cache(cache, token="WARMTOKEN")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=[1, 2, 3])

    _patch_transport(monkeypatch, handler)
    result = _api(cache).request("GET", "/v1/data")
    assert result == [1, 2, 3]
    assert captured["auth"] == "Bearer WARMTOKEN"


def test_request_assembles_method_path_body_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": 7})

    _patch_transport(monkeypatch, handler)
    result = _api().request(
        "POST",
        "/v1/items",
        body={"name": "x"},
        query={"limit": 10, "skip": None},
        no_auth=True,
    )
    assert result == {"id": 7}
    assert captured["method"] == "POST"
    url = captured["url"]
    assert isinstance(url, str)
    assert url == "https://api.test/api/v1/items?limit=10"
    assert captured["body"] == {"name": "x"}


def test_request_none_body_sends_no_content(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content"] = bytes(request.content)
        return httpx.Response(200, json={})

    _patch_transport(monkeypatch, handler)
    _api().request("GET", "/v1/ping", no_auth=True)
    assert captured["content"] == b""


def test_request_empty_response_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, text="")

    _patch_transport(monkeypatch, handler)
    assert _api().request("DELETE", "/v1/x", no_auth=True) is None


def test_request_4xx_raises_with_status_and_body(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404, text="not found here")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api().request("GET", "/v1/missing", no_auth=True)
    err = ei.value
    assert err.status == 404
    assert err.body == "not found here"
    assert "HTTP 404" in str(err)


def test_request_5xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500, text="boom")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api().request("GET", "/v1/x", no_auth=True)
    assert ei.value.status == 500


def test_request_body_truncated_in_error(monkeypatch: pytest.MonkeyPatch) -> None:
    big = "Z" * 700

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500, text=big)

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api().request("GET", "/v1/x", no_auth=True)
    body = ei.value.body
    assert body is not None
    assert body.startswith("Z" * 500)
    assert "bytes)" in body


def test_request_non_json_response_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, text="<html>not json</html>")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api().request("GET", "/v1/x", no_auth=True)
    assert "non-JSON response" in str(ei.value)


def test_request_transport_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns fail", request=request)

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api().request("GET", "/v1/x", no_auth=True)
    assert "transport error" in str(ei.value)


# --------------------------------------------------------------------------- #
# SlApi.login
# --------------------------------------------------------------------------- #


def test_login_posts_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"accessToken": "T"})

    _patch_transport(monkeypatch, handler)
    resp = _api().login()
    assert resp == {"accessToken": "T"}
    assert captured["path"] == "/api/auth/login"
    assert captured["auth"] is None  # login → no_auth=True
    assert captured["body"] == {"email": "e@x", "password": "pw"}


def test_login_override_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"accessToken": "T"})

    _patch_transport(monkeypatch, handler)
    _api().login(email="other@x", password="other-pw")
    assert captured["body"] == {"email": "other@x", "password": "other-pw"}


# --------------------------------------------------------------------------- #
# SlApi.get_token
# --------------------------------------------------------------------------- #


def test_get_token_warm_cache_skips_login(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cache = tmp_path / "tok.json"
    _valid_cache(cache, token="WARM")

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        raise AssertionError("login must not be called with warm cache")

    _patch_transport(monkeypatch, handler)
    assert _api(cache).get_token() == "WARM"


def test_get_token_cold_logs_in_and_writes_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "tok.json"
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"accessToken": "FRESH"})

    _patch_transport(monkeypatch, handler)
    api = _api(cache)
    assert api.get_token() == "FRESH"
    assert calls == ["/api/auth/login"]
    # Кеш записан → следующий вызов тёплый, без повторного логина.
    assert api.get_token() == "FRESH"
    assert calls == ["/api/auth/login"]
    written = read_token_cache(cache)
    assert written is not None
    assert written.token == "FRESH"


def test_get_token_expired_cache_triggers_login(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "tok.json"
    _write_cache(cache, {"token": "STALE", "expires_at": time.time() - 1})
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"accessToken": "RENEWED"})

    _patch_transport(monkeypatch, handler)
    assert _api(cache).get_token() == "RENEWED"
    assert calls == ["/api/auth/login"]


def test_get_token_no_access_token_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json={"foo": "bar"})

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError) as ei:
        _api(tmp_path / "tok.json").get_token()
    assert "нет accessToken" in str(ei.value)


def test_get_token_empty_access_token_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json={"accessToken": ""})

    _patch_transport(monkeypatch, handler)
    with pytest.raises(SlApiError):
        _api(tmp_path / "tok.json").get_token()


def test_request_authed_cold_cache_logs_in_first(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Полный путь: холодный кеш → login → затем сам запрос с Bearer."""
    cache = tmp_path / "tok.json"
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization")
        seen.append((request.url.path, auth))
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, json={"accessToken": "LIVE"})
        return httpx.Response(200, json={"value": 42})

    _patch_transport(monkeypatch, handler)
    result = _api(cache).request("GET", "/v1/data")
    assert result == {"value": 42}
    assert seen == [
        ("/api/auth/login", None),
        ("/api/v1/data", "Bearer LIVE"),
    ]
