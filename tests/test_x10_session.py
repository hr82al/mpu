"""Тесты `lib/x10_session.py` — кэш/refresh 10X-токенов в sqlite (`x10_sessions`)."""

import base64
import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from mpu.lib import store, x10_session
from mpu.lib.x10api import X10Api

FUTURE = 4102444800  # 2100 — заведомо валидный exp


def _jwt(exp: int) -> str:
    def seg(d: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    return f"{seg({'alg': 'HS256'})}.{seg({'exp': exp})}.sig"


def _ok(data: object) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def _api(handler: httpx.MockTransport) -> X10Api:
    return X10Api(base_url="https://x/api", email="s@x", password="pw", _transport=handler)


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    c = store.open_store(db_path)
    store.bootstrap(c)
    yield c
    c.close()


def test_jwt_exp_parses() -> None:
    assert x10_session.jwt_exp(_jwt(1700000000)) == 1700000000
    assert x10_session.jwt_exp("not.a.jwt") is None
    assert x10_session.jwt_exp("nodots") is None


def test_staff_token_cached(conn: sqlite3.Connection) -> None:
    state: dict[str, int] = {"login": 0}
    tok = _jwt(FUTURE)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            state["login"] += 1
            return _ok({"access_token": tok})
        return httpx.Response(404)

    api = _api(httpx.MockTransport(handler))
    assert x10_session.get_staff_token(conn, api) == tok
    assert x10_session.get_staff_token(conn, api) == tok
    assert state["login"] == 1  # второй вызов — из кэша


def test_staff_token_refreshes_when_expired(conn: sqlite3.Connection) -> None:
    state: dict[str, int] = {"login": 0}
    tokens = [_jwt(1), _jwt(FUTURE)]  # первый протухший (exp=1)

    def handler(request: httpx.Request) -> httpx.Response:
        state["login"] += 1
        return _ok({"access_token": tokens[min(state["login"] - 1, 1)]})

    api = _api(httpx.MockTransport(handler))
    assert x10_session.get_staff_token(conn, api) == tokens[0]
    assert x10_session.get_staff_token(conn, api) == tokens[1]  # протух → re-login
    assert state["login"] == 2


def test_impersonation_cached_reuse(conn: sqlite3.Connection) -> None:
    state: dict[str, int] = {"imp": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/auth/login"):
            return _ok({"access_token": _jwt(FUTURE)})
        if path.endswith("/auth/impersonate"):
            state["imp"] += 1
            return _ok({"access_token": _jwt(FUTURE)})
        return httpx.Response(404)

    api = _api(httpx.MockTransport(handler))
    t1 = x10_session.get_impersonation_token(conn, api, 7, reason="first")
    t2 = x10_session.get_impersonation_token(conn, api, 7, reason="ignored")  # reason не нужен
    assert t1 == t2
    assert state["imp"] == 1  # impersonate (audit) ровно один раз


def test_impersonation_retries_on_401(conn: sqlite3.Connection) -> None:
    state: dict[str, int] = {"imp": 0, "login": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/auth/login"):
            state["login"] += 1
            return _ok({"access_token": _jwt(FUTURE)})
        if path.endswith("/auth/impersonate"):
            state["imp"] += 1
            if state["imp"] == 1:
                return httpx.Response(401, json={"message": "staff expired"})
            return _ok({"access_token": _jwt(FUTURE)})
        return httpx.Response(404)

    api = _api(httpx.MockTransport(handler))
    assert x10_session.get_impersonation_token(conn, api, 7, reason="r")
    assert state["imp"] == 2  # повтор impersonate после 401
    assert state["login"] == 2  # форс-refresh staff-токена
