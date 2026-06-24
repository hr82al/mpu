# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Оркестрация резолва email → client_id через 10X (sw-back) admin API.

Поток (выполняется ТОЛЬКО из `commands/search.py::main`, не из shared-резолва):
staff_search(email) → exact-match юзер → impersonate(reason) → list_workspaces под
impersonation-токеном → owned workspace (`ownerId == user.id`) == client_id.

Результат кэшируется в `x10_email_clients`; токены — в `x10_sessions`
(см. `x10_session`). См. также mpu/CLAUDE.md §7 (read/write split): impersonate
пишет audit-строку на проде.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from mpu.lib import x10_session
from mpu.lib.x10api import X10Api, X10ApiError


class X10ResolveError(RuntimeError):
    """email не резолвится в client_id (нет точного юзера / нет owned workspace / …)."""


@dataclass(frozen=True)
class OwnedWorkspace:
    workspace_id: int  # == client_id
    name: str
    slug: str | None
    marketplace: str | None


@dataclass(frozen=True)
class EmailBundle:
    email: str
    target_user_id: str
    target_name: str | None
    is_email_verified: bool
    reason: str
    owned: list[OwnedWorkspace]
    workspaces_json: str  # сырой data[] из /workspaces (для кэша / вывода)
    fetched_at: int


def _now() -> int:
    return int(time.time())


def _retry_on_401(get_token: Callable[[bool], str], call: Callable[[str], Any]) -> Any:
    """`call(token)` со свежим токеном; на 401 — пере-получить токен (`force=True`) и
    повторить один раз. Покрывает случай, когда сервер отозвал сессию раньше exp."""
    try:
        return call(get_token(False))
    except X10ApiError as e:
        if e.status != 401:
            raise
        return call(get_token(True))


def _exact_user(users: list[Any], email: str) -> dict[str, Any]:
    exact = [
        u for u in users if isinstance(u, dict) and str(u.get("email", "")).lower() == email.lower()
    ]
    if not exact:
        raise X10ResolveError(
            f"10X staff search: нет пользователя с точным email {email!r} "
            f"(по substring найдено {len(users)}); проверь адрес или что это не staff-аккаунт"
        )
    if len(exact) > 1:
        ids = [u.get("id") for u in exact]
        raise X10ResolveError(f"10X staff search: несколько юзеров с email {email!r}: ids={ids}")
    return exact[0]


def fetch_email_bundle(
    conn: sqlite3.Connection, email: str, *, reason: str, api: X10Api | None = None
) -> EmailBundle:
    """Резолв email через 10X API + запись в кэш (`x10_email_clients`, `x10_sessions`).

    Бросает `X10ResolveError` (нет точного юзера / >1 / нет owned workspace) или
    `X10ApiError` (login/staff-роль/сеть). Возвращает `EmailBundle` с owned workspaces.
    """
    api = api or X10Api.from_env()
    email = email.lower()

    users = _retry_on_401(
        lambda force: x10_session.get_staff_token(conn, api, force=force),
        lambda token: api.staff_search(email, token=token),
    )
    user = _exact_user(users, email)
    raw_uid = user.get("id")
    if not isinstance(raw_uid, int):
        raise X10ResolveError(f"10X staff search: user.id не число: {raw_uid!r}")
    uid = raw_uid

    workspaces = _retry_on_401(
        lambda force: x10_session.get_impersonation_token(
            conn, api, uid, reason=reason, force=force
        ),
        lambda token: api.list_workspaces(token=token),
    )

    owned: list[OwnedWorkspace] = []
    for w in workspaces:
        if not isinstance(w, dict):
            continue
        if str(w.get("ownerId")) != str(uid):
            continue
        wid = w.get("id")
        if not isinstance(wid, int):
            continue
        owned.append(
            OwnedWorkspace(
                workspace_id=wid,
                name=str(w.get("name") or ""),
                slug=w.get("slug") if isinstance(w.get("slug"), str) else None,
                marketplace=w.get("marketplace") if isinstance(w.get("marketplace"), str) else None,
            )
        )

    bundle = EmailBundle(
        email=email,
        target_user_id=str(uid),
        target_name=user.get("name") if isinstance(user.get("name"), str) else None,
        is_email_verified=bool(user.get("isEmailVerified")),
        reason=reason,
        owned=owned,
        workspaces_json=json.dumps(workspaces, ensure_ascii=False),
        fetched_at=_now(),
    )
    _upsert_email_client(conn, bundle)
    return bundle


def _upsert_email_client(conn: sqlite3.Connection, bundle: EmailBundle) -> None:
    owned_ids = json.dumps([o.workspace_id for o in bundle.owned])
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO x10_email_clients "
            "(email, target_user_id, target_name, is_email_verified, owned_client_ids, "
            "workspaces_json, reason, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                bundle.email,
                bundle.target_user_id,
                bundle.target_name,
                1 if bundle.is_email_verified else 0,
                owned_ids,
                bundle.workspaces_json,
                bundle.reason,
                bundle.fetched_at,
            ),
        )
