"""Пост-действие `copy-client`: завести вход в локальный sw-front под скопированным клиентом.

После копии `client_id` в локальный sl-1 этот модуль идемпотентно засевает sw-back БД
workspaces (`mp-sw-pg`), чтобы можно было войти на http://sw.localhost/login и пользоваться
workspace'ом (`workspace.id == client_id`, sw-back шлёт `client_id = workspaceId` в sl-back):

- **user** — владелец: email `client_<id>@local.host`, пароль `123123`, email подтверждён;
- **workspace** `id == client_id`, владелец — этот user;
- **wb_cabinets** + **workspaces_wb_cabinets** — доступ владельца к кабинетам (sids клиента);
- **subscriptions** ACTIVE на каждый sid — снимает гейт «подписка неактивна/не оплачена» в sw-back.

Всё через `ON CONFLICT ... DO UPDATE` → команду можно гонять повторно (дозагрузка новых
данных), вход и проводка не ломаются и не плодят дублей.

⚠️ Логин — ВАЛИДНЫЙ email (sw-back валидирует `@IsEmail`), поэтому не голый `client_<id>`,
а `client_<id>@local.host`. Пароль лежит как bcrypt-хэш (sw-back: bcrypt cost 10, `compare`
читает соль+cost из самого хэша) → один предвычисленный хэш «123123» подходит всегда,
без зависимости bcrypt в самом mpu.
"""

from __future__ import annotations

import contextlib
import subprocess

import typer
from psycopg import sql

from mpu.lib.pg import PgConn

LOGIN_DOMAIN = "local.host"
LOGIN_PASSWORD = "123123"
# bcrypt(cost=10) от "123123"; sw-back bcrypt.compare читает соль+cost из самого хэша,
# поэтому конкретная соль не важна — этот хэш проверяется против пароля "123123".
_PASSWORD_HASH = "$2b$10$cxMCZzMdmIdDRmb18yA2w.JzCc.JPHz8oRp/660kaEDh/xrkSsCnS"
# верхний лимит активных SKU — чтобы подписочный active-SKU-lock не урезал набор в dev.
_SKU_ACTIVE_LIMIT = 100000
_REDIS_CONTAINER = "redis-dev"
_REDIS_PASSWORD = "some-redis-password"


def login_email(client_id: int) -> str:
    return f"client_{client_id}@{LOGIN_DOMAIN}"


def read_client_cabinets(sl_conn: PgConn, client_id: int) -> list[tuple[str, str, str]]:
    """Кабинеты клиента `(sid, name, trade_mark)` из локального sl-1 (после копии).

    sids берём из `public.clients_wb_cabinets` (гарантированно скопированы), имена
    обогащаем из `schema_<id>.wb_cabinets` (LEFT JOIN — если кабинета там нет, имя дефолтное).
    """
    schema = f"schema_{client_id}"
    # c.sid (public.clients_wb_cabinets) — varchar, w.sid (schema_<id>.wb_cabinets) — uuid:
    # сводим к text в JOIN, чтобы не зависеть от точного типа колонки.
    query = sql.SQL(
        "SELECT c.sid::text, w.name, w.trade_mark "
        "FROM public.clients_wb_cabinets c "
        "LEFT JOIN {}.wb_cabinets w ON w.sid::text = c.sid::text "
        "WHERE c.client_id = {} "
        "ORDER BY c.sid"
    ).format(sql.Identifier(schema), sql.Literal(client_id))
    with sl_conn.connect() as conn, conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()
    cabinets: list[tuple[str, str, str]] = []
    for sid, name, trade_mark in rows:
        cab_name = name or f"client {client_id}"
        cabinets.append((sid, cab_name, trade_mark or cab_name))
    return cabinets


def seed_login_workspace(
    ws_conn: PgConn, client_id: int, cabinets: list[tuple[str, str, str]]
) -> str:
    """Идемпотентно завести user+workspace+кабинеты+подписки в sw-back БД. Вернуть login email."""
    email = login_email(client_id)
    title = f"client {client_id}"
    slug = f"client-{client_id}"
    with ws_conn.connect() as conn:
        with conn.cursor() as cur:
            # 1) владелец-пользователь (email подтверждён, пароль "123123")
            cur.execute(
                sql.SQL(
                    "INSERT INTO public.users "
                    "(email, password, name, is_email_verified, updated_at) "
                    "VALUES ({email}, {pw}, {name}, true, now()) "
                    "ON CONFLICT (email) DO UPDATE SET "
                    "password = EXCLUDED.password, is_email_verified = true, "
                    "updated_at = now() RETURNING id"
                ).format(
                    email=sql.Literal(email),
                    pw=sql.Literal(_PASSWORD_HASH),
                    name=sql.Literal(title),
                )
            )
            row = cur.fetchone()
            if row is None:
                raise RuntimeError("users upsert не вернул id")
            user_id = row[0]

            # 2) workspace id == client_id, владелец — наш user
            cur.execute(
                sql.SQL(
                    "INSERT INTO public.workspaces "
                    "(id, name, slug, owner_id, marketplace, is_active, updated_at) "
                    "VALUES ({id}, {name}, {slug}, {owner}, 'Wildberries', true, now()) "
                    "ON CONFLICT (id) DO UPDATE SET "
                    "owner_id = EXCLUDED.owner_id, is_active = true, updated_at = now()"
                ).format(
                    id=sql.Literal(client_id),
                    name=sql.Literal(title),
                    slug=sql.Literal(slug),
                    owner=sql.Literal(user_id),
                )
            )

            # 3) на каждый sid: кабинет + связь с workspace + ACTIVE-подписка
            for sid, name, trade_mark in cabinets:
                cur.execute(
                    sql.SQL(
                        "INSERT INTO public.wb_cabinets "
                        "(sid, name, trade_mark, workspace_id, status, marketplace) "
                        "VALUES ({sid}::uuid, {name}, {tm}, {ws}, 'ACTIVE', 'wildberries') "
                        "ON CONFLICT (sid) DO UPDATE SET "
                        "workspace_id = EXCLUDED.workspace_id, name = EXCLUDED.name, "
                        "trade_mark = EXCLUDED.trade_mark"
                    ).format(
                        sid=sql.Literal(sid),
                        name=sql.Literal(name),
                        tm=sql.Literal(trade_mark),
                        ws=sql.Literal(client_id),
                    )
                )
                cur.execute(
                    sql.SQL(
                        "INSERT INTO public.workspaces_wb_cabinets (workspace_id, sid) "
                        "VALUES ({ws}, {sid}::uuid) ON CONFLICT (workspace_id, sid) DO NOTHING"
                    ).format(ws=sql.Literal(client_id), sid=sql.Literal(sid))
                )
                cur.execute(
                    sql.SQL(
                        "INSERT INTO public.subscriptions "
                        "(sid, is_paid, status, paid_from, paid_to, "
                        "sku_active_limit, is_active, updated_at) "
                        "VALUES ({sid}::uuid, true, 'ACTIVE', CURRENT_DATE, "
                        "(CURRENT_DATE + INTERVAL '365 days')::date, {lim}, true, now()) "
                        "ON CONFLICT (sid) DO UPDATE SET "
                        "is_paid = true, status = 'ACTIVE', is_active = true, "
                        "paid_from = CURRENT_DATE, "
                        "paid_to = (CURRENT_DATE + INTERVAL '365 days')::date, "
                        "sku_active_limit = {lim}, updated_at = now()"
                    ).format(sid=sql.Literal(sid), lim=sql.Literal(_SKU_ACTIVE_LIMIT))
                )
        conn.commit()
    typer.echo(
        f"  · sw-back: user {email} + workspace {client_id} + "
        f"{len(cabinets)} кабинет(ов) + подписки ACTIVE",
        err=True,
    )
    return email


def flush_sw_redis() -> None:
    """Сбросить кэш sw-back (workspace-access/feature-flags) — best-effort."""
    with contextlib.suppress(Exception):
        subprocess.run(
            ["docker", "exec", _REDIS_CONTAINER, "redis-cli", "-a", _REDIS_PASSWORD, "FLUSHALL"],
            check=False,
            capture_output=True,
            timeout=15,
        )
