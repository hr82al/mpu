"""Селектор → email цели impersonation (10X staff-поиск) — для `mpu search`.

У web-клиента 10X email в базах sl-back не хранится (только в sw-back), поэтому
вход в impersonation исторически был один — по email. sw-back ищет цель шире:
`GET /users/staff/search?query=<q>&scope=<user|access>` (`scope` отсутствует =
серверный `auto`).

Что чем ищется (проверено на проде 2026-07-27):

- `scope=user` — по пользователю: точный email, кусок email, имя (может вернуть
  десятки), `user.id` (целое). Запрос короче 2 символов → 400.
- `scope=access` — по доступу: workspace id (== `client_id`) или полный uuid sid
  кабинета; ответ несёт `match` (`via` workspace/cabinet, `role` owner/admin,
  `workspaceId`, `workspaceName`, `sid`, `cabinetName`).
- Названием клиента / воркспейса / кабинета не ищется НИЧЕМ: «Zefirnoe»,
  «Селищева» → 0 кандидатов. Название → `client_id` резолвится локальным кэшем
  (`mpu search <title>`), и уже `client_id` идёт в `scope=access`.
- Одно и то же число в разных скоупах — разные сущности: `1029` как `user.id`
  находит юзера, как workspace id — никого. Поэтому `auto` для целого трактует
  его как `client_id` (частый случай в поддержке), а `--scope user` — как
  `user.id`.

Здесь — только шаг «селектор → email»; дальше `commands/search.py` идёт обычным
email-путём (impersonate + кэш), где и пишется audit-строка на проде. Тёплый кэш
(`x10_email_clients.owned_client_ids` уже содержит этот `client_id`) резолвится
локально, обращения к 10X нет.
"""

from __future__ import annotations

import json
import re
import sqlite3
from enum import StrEnum

from mpu.lib.jsonx import is_list


class Scope(StrEnum):
    """Чем считать селектор при 10X-резолве (зеркало `StaffSearchScope` sw-back)."""

    auto = "auto"
    user = "user"
    access = "access"


_SID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_INT_RE = re.compile(r"^\d+$")


def looks_like_sid(value: str) -> bool:
    """Полный uuid кабинета — ровно тот формат, который принимает `scope=access`."""
    return bool(_SID_RE.match(value))


def effective_scope(value: str, scope: Scope) -> Scope:
    """`auto` → конкретный скоуп: целое/uuid → access, остальное → user."""
    if scope is not Scope.auto:
        return scope
    return Scope.access if looks_like_sid(value) or _INT_RE.match(value) else Scope.user


def cached_email(conn: sqlite3.Connection, client_id: int) -> str | None:
    """email из кэша `x10_email_clients`, если этот `client_id` уже среди owned."""
    try:
        cur = conn.execute("SELECT email, owned_client_ids FROM x10_email_clients")
    except sqlite3.OperationalError:
        return None
    for row in cur.fetchall():
        try:
            parsed: object = json.loads(row["owned_client_ids"])
        except (ValueError, TypeError):
            continue
        if is_list(parsed) and client_id in parsed:
            return str(row["email"])
    return None


def resolve_email(
    conn: sqlite3.Connection,
    query: str,
    *,
    scope: Scope,
    client_id: int | None,
    refresh_cache: bool,
) -> str:
    """Селектор → email цели impersonation. `refresh_cache` обходит локальный кэш.

    Бросает `x10_resolve.X10AmbiguousError` (несколько кандидатов — список в поле
    `candidates`), `x10_resolve.X10ResolveError` (никого не нашли) или
    `x10api.X10ApiError` (сеть, staff-креды).
    """
    eff = effective_scope(query, scope)
    if not refresh_cache and eff is Scope.access and client_id is not None:
        hit = cached_email(conn, client_id)
        if hit is not None:
            return hit
    from mpu.lib import x10_resolve  # lazy: тянет httpx

    return x10_resolve.fetch_staff_target(conn, query, scope=str(eff)).email
