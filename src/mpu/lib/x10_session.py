# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Solid-кэш 10X-сессий (JWT-токенов) в sqlite-таблице `x10_sessions`.

Переиспользуемый примитив для ЛЮБЫХ вызовов 10X API: токены (staff + per-user
impersonation) кэшируются с TTL из `exp` JWT, авто-рефрешатся на протухании, а
причина (`reason`) хранится в строке сессии — поэтому повторные вызовы НЕ требуют
повторно указывать причину («для других команд не указывать причину»).

Инвариант read/write split (mpu/CLAUDE.md §7): создание impersonation-сессии
пишет audit-строку на проде (sw-back `impersonation_sessions`). Переиспользование
валидной кэш-сессии — без побочек. Единственный код-путь, который СОЗДАЁТ
сессию из `mpu`, — `commands/search.py::main` при email-селекторе.
"""

from __future__ import annotations

import base64
import binascii
import json
import sqlite3
import time

from mpu.lib.x10api import X10Api, X10ApiError

# Считаем токен протухшим за `_SKEW_SECONDS` до реального exp — запас на дрейф
# часов и сетевую задержку. Если exp не распарсился — короткий fallback-TTL.
_SKEW_SECONDS = 60
_FALLBACK_TTL_SECONDS = 600


def _now() -> int:
    return int(time.time())


def jwt_exp(token: str) -> int | None:
    """Unix-`exp` из payload JWT (без верификации подписи). Любой сбой → `None`."""
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    pad = "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload + pad)
        data = json.loads(raw)
    except (binascii.Error, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    exp = data.get("exp")
    return int(exp) if isinstance(exp, (int, float)) else None


def _read_valid(conn: sqlite3.Connection, kind: str, subject: str) -> str | None:
    """Валидный (не протухший) токен из кэша или `None`.

    Таблица `x10_sessions` добавлена позже базовой схемы — на старом кэше её ещё
    нет; деградируем в `None` (трактуем как miss), схема дотянется на bootstrap.
    """
    try:
        cur = conn.execute(
            "SELECT token, expires_at FROM x10_sessions WHERE kind = ? AND subject = ?",
            (kind, subject),
        )
    except sqlite3.OperationalError:
        return None
    row = cur.fetchone()
    if row is None:
        return None
    if int(row["expires_at"]) <= _now():
        return None
    return row["token"]


def _store(
    conn: sqlite3.Connection, kind: str, subject: str, token: str, reason: str | None
) -> None:
    exp = jwt_exp(token)
    expires_at = (exp - _SKEW_SECONDS) if exp is not None else (_now() + _FALLBACK_TTL_SECONDS)
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO x10_sessions "
            "(kind, subject, token, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (kind, subject, token, reason, _now(), expires_at),
        )


def get_staff_token(conn: sqlite3.Connection, api: X10Api, *, force: bool = False) -> str:
    """Валидный staff-токен из кэша; на miss/протухании/`force` — re-login + пере-кэш.

    Subject сессии = email кред (смена `X10_TOKEN_EMAIL` не переиспользует чужой токен).
    Re-login побочек на проде не пишет (это не impersonation).
    """
    subject = api.email.lower()
    if not force:
        cached = _read_valid(conn, "staff", subject)
        if cached is not None:
            return cached
    data = api.login()
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise X10ApiError("10X login: нет access_token в ответе")
    _store(conn, "staff", subject, token, None)
    return token


def get_impersonation_token(
    conn: sqlite3.Connection, api: X10Api, target_user_id: int, *, reason: str, force: bool = False
) -> str:
    """Валидный impersonation-токен для пользователя из кэша; на miss/протухании/`force`
    — новый impersonate + пере-кэш.

    Создание impersonation **пишет audit-строку на проде** с `reason`. Reason
    потребляется ТОЛЬКО при создании; переиспользование валидной кэш-сессии reason
    не требует. Если staff-токен протух в момент impersonate (401) — рефрешим его
    и повторяем один раз.
    """
    subject = str(target_user_id)
    if not force:
        cached = _read_valid(conn, "impersonation", subject)
        if cached is not None:
            return cached
    try:
        data = api.impersonate(target_user_id, reason, token=get_staff_token(conn, api))
    except X10ApiError as e:
        if e.status != 401:
            raise
        data = api.impersonate(target_user_id, reason, token=get_staff_token(conn, api, force=True))
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise X10ApiError("10X impersonate: нет access_token в ответе")
    _store(conn, "impersonation", subject, token, reason)
    return token
