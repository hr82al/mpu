# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Оркестрация резолва email → client_id через 10X (sw-back) admin API.

Поток (выполняется ТОЛЬКО из `commands/search.py::main`, не из shared-резолва):
staff_search(email) → exact-match юзер → impersonate(reason) → list_workspaces под
impersonation-токеном → owned workspace (`ownerId == user.id`) == client_id.

Вход может быть и не email: `fetch_staff_target` резолвит в email цели любой
селектор, который понимает staff-поиск sw-back — `client_id` (== workspace id)
и sid кабинета (`scope=access`), кусок email / имя / `user.id` (`scope=user`), —
после чего работает тот же email-поток. Что каким скоупом ищется (и что НЕ
ищется — название клиента) — в `commands/_search_x10.py`.

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
    """Селектор не резолвится (нет точного юзера / нет owned workspace / …)."""


class X10AmbiguousError(X10ResolveError):
    """Кандидатов больше одного — выбор за оператором; список в `candidates`."""

    def __init__(self, message: str, *, candidates: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.candidates = candidates


@dataclass(frozen=True)
class OwnedWorkspace:
    workspace_id: int  # == client_id
    name: str
    slug: str | None
    marketplace: str | None


@dataclass(frozen=True)
class StaffTarget:
    """Кого имперсонировать по итогам staff-поиска (любой скоуп).

    `role`/`via`/`workspace_*` заполнены только для `scope=access` — там ответ
    несёт блок `match`; поиск по пользователю его не возвращает.
    """

    email: str
    user_id: int
    role: str | None  # owner / admin
    via: str | None  # workspace / cabinet
    workspace_id: int | None
    workspace_name: str | None


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


def _retry_on_401(get_token: Callable[[bool], str], call: Callable[[str], Any]) -> Any:  # noqa: ANN401
    """`call(token)` со свежим токеном; на 401 — пере-получить токен (`force=True`) и
    повторить один раз. Покрывает случай, когда сервер отозвал сессию раньше exp."""
    try:
        return call(get_token(False))
    except X10ApiError as e:
        if e.status != 401:  # noqa: PLR2004
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


def _match_of(candidate: dict[str, Any]) -> dict[str, Any]:
    match = candidate.get("match")
    return match if isinstance(match, dict) else {}


def _candidate_brief(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "user_id": c.get("id"),
            "email": c.get("email"),
            "name": c.get("name"),
            "match": _match_of(c) or None,
        }
        for c in candidates
    ]


def pick_staff_candidate(candidates: list[Any], query: str, *, scope: str) -> dict[str, Any]:
    """Из ответа staff-поиска выбрать, под кем заходить.

    Порядок: точное совпадение email с запросом → владелец воркспейса
    (`match.role == "owner"`, приходит только в `scope=access`) → единственный
    кандидат. Несколько равных — `X10AmbiguousError` со списком: выбор за
    оператором (по имени легко получить десятки однофамильцев).
    """
    usable = [c for c in candidates if isinstance(c, dict) and isinstance(c.get("email"), str)]
    if not usable:
        raise X10ResolveError(
            f"10X staff search (scope={scope}): по {query!r} никого не найдено; "
            "названием клиента/кабинета не ищется — используй client_id, sid, email или имя"
        )
    exact = [c for c in usable if str(c["email"]).lower() == query.lower()]
    if exact:
        return exact[0]
    owners = [c for c in usable if _match_of(c).get("role") == "owner"]
    pool = owners or usable
    if len(pool) > 1:
        raise X10AmbiguousError(
            f"10X staff search (scope={scope}): по {query!r} найдено кандидатов: "
            f"{len(pool)}; повтори с точным email или с user.id (--scope user)",
            candidates=_candidate_brief(pool),
        )
    return pool[0]


def fetch_staff_target(
    conn: sqlite3.Connection, query: str, *, scope: str, api: X10Api | None = None
) -> StaffTarget:
    """Селектор → цель impersonation одним staff-запросом.

    `scope="access"` — `client_id` (== workspace id) или полный uuid sid кабинета
    (вернётся владелец воркспейса); `scope="user"` — email, кусок email, имя или
    `user.id`. Impersonation здесь НЕ выполняется: функция только даёт email,
    дальше идёт обычный email-путь (`fetch_email_bundle`), где и пишется audit.
    """
    api = api or X10Api.from_env()
    candidates = _retry_on_401(
        lambda force: x10_session.get_staff_token(conn, api, force=force),
        lambda token: api.staff_search(query, token=token, scope=scope),
    )
    candidate = pick_staff_candidate(candidates, query, scope=scope)
    raw_uid = candidate.get("id")
    if not isinstance(raw_uid, int):
        raise X10ResolveError(f"10X staff search (scope={scope}): user.id не число: {raw_uid!r}")
    match = _match_of(candidate)
    wid = match.get("workspaceId")
    return StaffTarget(
        email=str(candidate["email"]).lower(),
        user_id=raw_uid,
        role=match.get("role") if isinstance(match.get("role"), str) else None,
        via=match.get("via") if isinstance(match.get("via"), str) else None,
        workspace_id=wid if isinstance(wid, int) else None,
        workspace_name=(
            match.get("workspaceName") if isinstance(match.get("workspaceName"), str) else None
        ),
    )


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
