"""Тесты `lib/x10_resolve.py` — оркестрация email → client_id (end-to-end через MockTransport)."""

import base64
import json
import sqlite3
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path

import httpx
import pytest

from mpu.lib import store, x10_resolve
from mpu.lib.x10api import X10Api

FUTURE = 4102444800
STAFF = "STAFF.TOKEN.s"
IMP = "IMP.TOKEN.i"


def _jwt(value: str, exp: int = FUTURE) -> str:
    head = base64.urlsafe_b64encode(json.dumps({"alg": "x"}).encode()).rstrip(b"=").decode()
    payload = (
        base64.urlsafe_b64encode(json.dumps({"exp": exp, "v": value}).encode())
        .rstrip(b"=")
        .decode()
    )
    return f"{head}.{payload}.sig"


def _ok(data: object) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def _api(handler: Callable[[httpx.Request], httpx.Response]) -> X10Api:
    return X10Api(
        base_url="https://x/api",
        email="s@x",
        password="pw",
        _transport=httpx.MockTransport(handler),
    )


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    c = store.open_store(db_path)
    store.bootstrap(c)
    yield c
    c.close()


def _full_handler(
    users: Sequence[object], workspaces: Sequence[object]
) -> Callable[[httpx.Request], httpx.Response]:
    staff = _jwt(STAFF)
    imp = _jwt(IMP)

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/auth/login"):
            return _ok({"access_token": staff})
        if path.endswith("/users/staff/search"):
            assert request.headers["authorization"] == f"Bearer {staff}"
            return _ok(users)
        if path.endswith("/auth/impersonate"):
            return _ok({"access_token": imp, "user": {"id": 42}})
        if path.endswith("/workspaces"):
            # list_workspaces ОБЯЗАН идти под impersonation-токеном, не staff
            assert request.headers["authorization"] == f"Bearer {imp}"
            return _ok(workspaces)
        return httpx.Response(404)

    return handler


def test_resolves_owned_client_and_caches(conn: sqlite3.Connection) -> None:
    users = [{"id": 42, "email": "a@b.ru", "name": "Ann", "isEmailVerified": True}]
    workspaces = [
        {"id": 100, "name": "WS", "slug": "ws", "marketplace": "wb", "ownerId": 42},
        {"id": 200, "name": "Other", "ownerId": 99},  # member-only
    ]
    api = _api(_full_handler(users, workspaces))
    bundle = x10_resolve.fetch_email_bundle(conn, "A@B.ru", reason="ТП X", api=api)

    assert bundle.target_user_id == "42"
    assert bundle.is_email_verified is True
    assert [o.workspace_id for o in bundle.owned] == [100]
    assert bundle.owned[0].marketplace == "wb"

    cur = conn.execute(
        "SELECT owned_client_ids, reason FROM x10_email_clients WHERE email = ?", ("a@b.ru",)
    )
    row = cur.fetchone()
    assert row is not None
    assert json.loads(row["owned_client_ids"]) == [100]
    assert row["reason"] == "ТП X"


def test_exact_email_filter_picks_match(conn: sqlite3.Connection) -> None:
    users = [
        {"id": 1, "email": "other@b.ru"},
        {"id": 42, "email": "a@b.ru", "name": "Ann", "isEmailVerified": True},
    ]
    workspaces = [{"id": 100, "name": "WS", "ownerId": 42}]
    api = _api(_full_handler(users, workspaces))
    bundle = x10_resolve.fetch_email_bundle(conn, "a@b.ru", reason="r", api=api)
    assert bundle.target_user_id == "42"
    assert [o.workspace_id for o in bundle.owned] == [100]


def test_no_exact_email_raises(conn: sqlite3.Connection) -> None:
    api = _api(_full_handler([{"id": 1, "email": "other@b.ru"}], []))
    with pytest.raises(x10_resolve.X10ResolveError):
        x10_resolve.fetch_email_bundle(conn, "a@b.ru", reason="r", api=api)


def test_owns_no_workspace_empty_owned(conn: sqlite3.Connection) -> None:
    users = [{"id": 42, "email": "a@b.ru", "isEmailVerified": True}]
    workspaces = [{"id": 200, "name": "Other", "ownerId": 99}]  # только member-only
    api = _api(_full_handler(users, workspaces))
    bundle = x10_resolve.fetch_email_bundle(conn, "a@b.ru", reason="r", api=api)
    assert bundle.owned == []


# ── селектор доступа: client_id / sid → владелец воркспейса (scope=access) ───


def _owner(email: str, uid: int, *, via: str = "workspace") -> dict[str, object]:
    return {
        "id": uid,
        "email": email,
        "name": "Дмитрий",
        "isEmailVerified": True,
        "match": {"via": via, "role": "owner", "workspaceId": 2759, "workspaceName": "ИП С."},
    }


def _member(email: str, uid: int) -> dict[str, object]:
    return {
        "id": uid,
        "email": email,
        "match": {"via": "workspace", "role": "admin", "workspaceId": 2759},
    }


def test_pick_access_candidate_prefers_owner() -> None:
    picked = x10_resolve.pick_staff_candidate(
        [_member("m@b.ru", 7), _owner("o@b.ru", 42)], "2759", scope="access"
    )
    assert picked["id"] == 42


def test_pick_access_candidate_single_member_without_owner() -> None:
    picked = x10_resolve.pick_staff_candidate([_member("m@b.ru", 7)], "2759", scope="access")
    assert picked["id"] == 7


def test_pick_access_candidate_ambiguous_raises() -> None:
    with pytest.raises(x10_resolve.X10AmbiguousError) as ei:
        x10_resolve.pick_staff_candidate(
            [_member("m@b.ru", 7), _member("n@b.ru", 8)], "2759", scope="access"
        )
    assert {c["email"] for c in ei.value.candidates} == {"m@b.ru", "n@b.ru"}


def test_pick_staff_candidate_exact_email_wins() -> None:
    """Поиск по куску email вернул многих — точное совпадение снимает неоднозначность."""
    picked = x10_resolve.pick_staff_candidate(
        [{"id": 1, "email": "dselishev1@yandex.ru"}, {"id": 2, "email": "dselishev12@yandex.ru"}],
        "DSelishev1@yandex.ru",
        scope="user",
    )
    assert picked["id"] == 1


def test_fetch_staff_target_user_scope_without_match(conn: sqlite3.Connection) -> None:
    """scope=user: у кандидата нет блока `match` — поля воркспейса остаются пустыми."""
    seen: list[str] = []
    staff = _jwt(STAFF)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            return _ok({"access_token": staff})
        seen.append(str(request.url.params.get("scope")))
        return _ok([{"id": 1029, "email": "d@ya.ru", "name": "Дмитрий"}])

    target = x10_resolve.fetch_staff_target(conn, "1029", scope="user", api=_api(handler))
    assert seen == ["user"]
    assert (target.email, target.user_id) == ("d@ya.ru", 1029)
    assert (target.role, target.via, target.workspace_id) == (None, None, None)


def test_pick_access_candidate_empty_raises() -> None:
    with pytest.raises(x10_resolve.X10ResolveError):
        x10_resolve.pick_staff_candidate([], "2759", scope="access")


def test_fetch_access_target_sends_scope_access(conn: sqlite3.Connection) -> None:
    seen: list[str] = []
    staff = _jwt(STAFF)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            return _ok({"access_token": staff})
        if request.url.path.endswith("/users/staff/search"):
            seen.append(str(request.url.params.get("scope")))
            return _ok([_owner("o@b.ru", 42, via="cabinet")])
        return httpx.Response(404)

    target = x10_resolve.fetch_staff_target(conn, "2759", scope="access", api=_api(handler))
    assert seen == ["access"]
    assert target.email == "o@b.ru"
    assert target.user_id == 42
    assert (target.via, target.role) == ("cabinet", "owner")
    assert (target.workspace_id, target.workspace_name) == (2759, "ИП С.")


def test_fetch_access_target_uppercase_email_normalised(conn: sqlite3.Connection) -> None:
    staff = _jwt(STAFF)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            return _ok({"access_token": staff})
        return _ok([_owner("O@B.ru", 42)])

    assert (
        x10_resolve.fetch_staff_target(conn, "2759", scope="access", api=_api(handler)).email
        == "o@b.ru"
    )
