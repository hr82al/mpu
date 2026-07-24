"""Очистка локального dev-стека от данных скопированных клиентов (для `mpu clean-local-clients`).

Удаляет per-client данные из ЛОКАЛЬНЫХ PG — sl-1 (`mp-sl-1-pg`), sl-0 main (`mp-sl-0-pg`)
и sw-back (`mp-sw-pg`), — КРОМЕ keep-листа client_id и `shared`-схемы (справочники
`copy-shared`, не привязаны к клиенту). Только локальные контейнеры, никогда не прод.

Состав на клиента — зеркало того, что заливает `copy-client`:
- sl-1: `DROP SCHEMA schema_<id> CASCADE` + public-строки клиента (loader_info, spreadsheets, …);
- sl-0: токен-строки (clients/wb_tokens/clients_wb_cabinets);
- sw-back: проводка входа (user `client_<id>@local.host` + workspace + кабинеты + подписки) —
  трогаем ТОЛЬКО то, что сами завели (по email-сигнатуре), чужие seed-workspace не удаляем.
"""

from __future__ import annotations

import re

from psycopg import sql

from mpu.lib import pg_copy, sw_seed
from mpu.lib.pg import PgConn

_SCHEMA_RE = re.compile(r"^schema_(\d+)$")

# public-таблицы клиента на sl-1 (clients по id, остальные по client_id) — набор copy-client.
_SL1_CLIENT_TABLES: tuple[str, ...] = ("clients", *pg_copy.CLIENT_ID_TABLES)
_SL1_SS_TABLES: tuple[str, ...] = pg_copy.SPREADSHEET_TABLES
# токен-строки на sl-0 main.
_SL0_CLIENT_TABLES: tuple[str, ...] = ("clients", *pg_copy.MAIN_CLIENT_TABLES)


def local_client_ids(sl_conn: PgConn) -> list[int]:
    """client_id всех локальных схем `schema_<id>` на sl-1 (отсортировано)."""
    with sl_conn.connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT nspname FROM pg_namespace WHERE nspname ~ '^schema_[0-9]+$'")
        rows = cur.fetchall()
    ids: list[int] = []
    for (name,) in rows:
        m = _SCHEMA_RE.match(name)
        if m:
            ids.append(int(m.group(1)))
    return sorted(ids)


def _ids_list(client_ids: list[int]) -> sql.Composable:
    return sql.SQL(", ").join(sql.Literal(i) for i in client_ids)


def _clean_sl1(sl_conn: PgConn, client_ids: list[int]) -> None:
    ids = _ids_list(client_ids)
    with sl_conn.connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = replica")  # суперюзер локально, FK off
            for table in _SL1_SS_TABLES:
                cur.execute(
                    sql.SQL(
                        "DELETE FROM public.{} WHERE spreadsheet_id IN "
                        "(SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id IN ({}))"
                    ).format(sql.Identifier(table), ids)
                )
            for table in _SL1_CLIENT_TABLES:
                col = "id" if table == "clients" else "client_id"
                cur.execute(
                    sql.SQL("DELETE FROM public.{} WHERE {} IN ({})").format(
                        sql.Identifier(table), sql.Identifier(col), ids
                    )
                )
            for cid in client_ids:
                cur.execute(
                    sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(
                        sql.Identifier(f"schema_{cid}")
                    )
                )
        conn.commit()


def _clean_sl0(main_conn: PgConn, client_ids: list[int]) -> None:
    ids = _ids_list(client_ids)
    with main_conn.connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = replica")
            for table in _SL0_CLIENT_TABLES:
                col = "id" if table == "clients" else "client_id"
                cur.execute(
                    sql.SQL("DELETE FROM public.{} WHERE {} IN ({})").format(
                        sql.Identifier(table), sql.Identifier(col), ids
                    )
                )
        conn.commit()


def _clean_sw(ws_conn: PgConn, client_ids: list[int]) -> int:
    """Снести нашу проводку входа в sw-back. Вернуть число удалённых workspace'ов.

    Удаляем ТОЛЬКО seed-проводку (`workspace.id == client_id`, владелец — `client_<id>@local.host`)
    в FK-безопасном порядке. `session_replication_role` тут недоступен (workspacesapp не
    суперюзер), поэтому порядок явный: subs → links → cabinets → workspace → user.
    """
    removed = 0
    with ws_conn.connect() as conn:
        with conn.cursor() as cur:
            for cid in client_ids:
                email = sw_seed.login_email(cid)
                cur.execute(
                    sql.SQL("SELECT id FROM public.users WHERE email = {}").format(
                        sql.Literal(email)
                    )
                )
                user_row = cur.fetchone()
                if user_row is None:
                    continue
                user_id = user_row[0]
                cid_lit = sql.Literal(cid)
                cur.execute(
                    sql.SQL(
                        "SELECT 1 FROM public.workspaces WHERE id = {} AND owner_id = {}"
                    ).format(cid_lit, sql.Literal(user_id))
                )
                if cur.fetchone() is not None:
                    cur.execute(
                        sql.SQL(
                            "DELETE FROM public.subscriptions WHERE sid IN "
                            "(SELECT sid FROM public.workspaces_wb_cabinets "
                            "WHERE workspace_id = {})"
                        ).format(cid_lit)
                    )
                    cur.execute(
                        sql.SQL(
                            "DELETE FROM public.workspaces_wb_cabinets WHERE workspace_id = {}"
                        ).format(cid_lit)
                    )
                    cur.execute(
                        sql.SQL("DELETE FROM public.wb_cabinets WHERE workspace_id = {}").format(
                            cid_lit
                        )
                    )
                    cur.execute(
                        sql.SQL("DELETE FROM public.workspaces WHERE id = {}").format(cid_lit)
                    )
                    removed += 1
                cur.execute(
                    sql.SQL("DELETE FROM public.users WHERE id = {}").format(sql.Literal(user_id))
                )
        conn.commit()
    return removed


def clean_clients(
    sl_conn: PgConn, main_conn: PgConn, ws_conn: PgConn, client_ids: list[int]
) -> int:
    """Удалить данные `client_ids` из sl-1 + sl-0 + sw-back. Вернуть число снятых workspace'ов."""
    if not client_ids:
        return 0
    _clean_sl1(sl_conn, client_ids)
    _clean_sl0(main_conn, client_ids)
    return _clean_sw(ws_conn, client_ids)
