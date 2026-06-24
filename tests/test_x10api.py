"""Тесты `lib/x10api.py` — HTTP-клиент 10X через httpx.MockTransport."""

import json

import httpx
import pytest

from mpu.lib.x10api import X10Api, X10ApiError


def _api(handler: httpx.MockTransport) -> X10Api:
    return X10Api(base_url="https://x/api", email="s@x", password="pw", _transport=handler)


def _ok(data: object) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def test_login_unwraps_data() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/auth/login"
        assert json.loads(request.content) == {"email": "s@x", "password": "pw"}
        return _ok({"access_token": "T", "user": {"id": 5}})

    data = _api(httpx.MockTransport(handler)).login()
    assert data["access_token"] == "T"


def test_staff_search_passes_query_and_bearer() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/users/staff/search"
        assert request.url.params.get("query") == "a@b.ru"
        assert request.headers["authorization"] == "Bearer STAFF"
        return _ok([{"id": 1, "email": "a@b.ru"}])

    users = _api(httpx.MockTransport(handler)).staff_search("a@b.ru", token="STAFF")
    assert users[0]["email"] == "a@b.ru"


def test_impersonate_sends_reason_and_target() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _ok({"access_token": "IMP", "user": {"id": 9}})

    data = _api(httpx.MockTransport(handler)).impersonate(9, "ТП 2026-06-24", token="STAFF")
    assert captured["body"] == {"targetUserId": 9, "reason": "ТП 2026-06-24"}
    assert data["access_token"] == "IMP"


def test_list_workspaces_uses_given_token() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        return _ok([{"id": 100, "ownerId": 9}])

    _api(httpx.MockTransport(handler)).list_workspaces(token="IMP")
    assert seen["auth"] == "Bearer IMP"


def test_http_error_carries_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"statusCode": 401, "message": "no"})

    with pytest.raises(X10ApiError) as ei:
        _api(httpx.MockTransport(handler)).login()
    assert ei.value.status == 401


def test_staff_search_non_list_data_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _ok({"oops": 1})

    with pytest.raises(X10ApiError):
        _api(httpx.MockTransport(handler)).staff_search("a@b", token="t")


def test_missing_data_field_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"success": True})

    with pytest.raises(X10ApiError):
        _api(httpx.MockTransport(handler)).login()


def test_resolve_credentials_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    from mpu.lib import x10api

    monkeypatch.delenv("X10_TOKEN_EMAIL", raising=False)
    monkeypatch.delenv("X10_TOKEN_PASSWORD", raising=False)
    monkeypatch.delenv("X10_API_URL", raising=False)
    monkeypatch.setenv("TOKEN_EMAIL", "e")
    monkeypatch.setenv("TOKEN_PASSWORD", "p")
    assert x10api.resolve_credentials() == ("e", "p")
    assert x10api.resolve_base_url() == x10api.DEFAULT_BASE_URL
