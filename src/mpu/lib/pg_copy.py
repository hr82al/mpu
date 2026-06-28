"""Примитивы копии клиентской схемы + public-строк между PG (`pg_dump`/`pg_restore` + COPY).

Используется `mpu copy-client` (прод-инстанс → локальный sl-1) и `mpu copy-dev`
(dev-стенд → локальный sl-1): логика одна, различается только источник (резолв
селектора vs фиксированный dev-PG) и подпись источника в выводе.

Схема восстанавливается через `DROP SCHEMA ... CASCADE` + `pg_restore --no-owner
--no-privileges` — дамп несёт `CREATE SCHEMA`, поэтому схема **создаётся сама, если её
не было** (отдельный `make-schema` перед копией не нужен), а `--no-*` убирает зависимость
от ролей `client_<id>`/`support_*` на target. Public-строки грузятся под
`session_replication_role = replica` (FK/триггеры off, порядок таблиц неважен).
Набор public-таблиц клиента — зеркало стадий `clientsTransfer.service.js`.

Каждый шаг печатает прогресс в stderr (дамп/восстановление с `--verbose` + heartbeat,
построчные счётчики по таблицам) — чтобы был виден весь процесс копии.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import psycopg
import typer
from psycopg import sql

from mpu.lib import servers
from mpu.lib.pg import PgConn

# public-таблицы клиента (фильтр по client_id). `spreadsheets` — родитель SPREADSHEET_TABLES.
CLIENT_ID_TABLES = (
    "wb_tokens",
    "clients_wb_cabinets",
    "clients_modules",
    "data_loader_info",
    "data_processor_info",
    "ozon_loader_info",
    "ozon_loader_info_v2",
    "wb_loader_info",
    "wb_loader_info_v2",
    "wb_loader_nm_ids_data",
    "spreadsheets",
)
# дети public.spreadsheets (фильтр по spreadsheet_id клиента).
SPREADSHEET_TABLES = (
    "spreadsheets_sheets",
    "spreadsheets_sheets_values",
    "spreadsheets_datasets",
    "spreadsheets_datasets_values",
    "spreadsheets_loader_data",
)
# токен-строки на sl-0/main: authoritative store, откуда wb-cabinet/clientsWbTokens читают
# (`listCabinetTokensMetadata`/`removeCabinetTokens` + HTTP `/v1/cabinet/*`). Instance (sl-1) —
# read-only реплика wb_tokens, поэтому для проверки токен-флоу нужны строки именно на main.
MAIN_CLIENT_TABLES = (
    "wb_tokens",
    "clients_wb_cabinets",
)


def run_pg_tool(argv: list[str], conn: PgConn, label: str, *, heartbeat: float = 10.0) -> None:
    """Прогнать `pg_dump`/`pg_restore` c PGPASSWORD из conn; упасть на ненулевом коде.

    Вывод инструмента (`--verbose` → построчный прогресс по таблицам) стримится живьём;
    раз в `heartbeat` секунд печатается «работаю, прошло Ns», чтобы долгий дамп не выглядел
    зависшим.
    """
    env = {**os.environ, "PGPASSWORD": conn.password}
    typer.echo(f"$ {' '.join(argv)}", err=True)
    start = time.monotonic()
    proc = subprocess.Popen(
        argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    assert proc.stdout is not None

    def _pump() -> None:
        for line in proc.stdout:  # pyright: ignore[reportOptionalIterable]
            typer.echo(f"  {line.rstrip()}", err=True)

    pump = threading.Thread(target=_pump, daemon=True)
    pump.start()

    while True:
        try:
            rc = proc.wait(timeout=heartbeat)
            break
        except subprocess.TimeoutExpired:
            typer.echo(f"  … {label}: работаю, прошло {int(time.monotonic() - start)}s", err=True)

    pump.join(timeout=2.0)
    elapsed = int(time.monotonic() - start)
    if rc != 0:
        typer.echo(f"{label} failed (exit {rc}, {elapsed}s)", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"  ✓ {label}: готово за {elapsed}s", err=True)


def pg_dump_argv(conn: PgConn, extra: list[str]) -> list[str]:
    return [
        "pg_dump",
        "-h",
        conn.host,
        "-p",
        conn.port,
        "-U",
        conn.user,
        "-d",
        conn.dbname,
        "-Fc",
        "--verbose",
        *extra,
    ]


def pg_restore_argv(conn: PgConn, extra: list[str], path: Path) -> list[str]:
    return [
        "pg_restore",
        "-h",
        conn.host,
        "-p",
        conn.port,
        "-U",
        conn.user,
        "-d",
        conn.dbname,
        "--verbose",
        *extra,
        str(path),
    ]


def ss_ids(conn: psycopg.Connection, client_id: int) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL("SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id = {}").format(
                sql.Literal(client_id)
            )
        )
        return {row[0] for row in cur.fetchall()}


def where_ss(ids: set[str]) -> sql.Composable:
    if not ids:
        return sql.SQL("false")
    return sql.SQL("spreadsheet_id IN ({})").format(
        sql.SQL(", ").join(sql.Literal(v) for v in sorted(ids))
    )


def replace_rows(
    src: psycopg.Connection,
    dst: psycopg.Connection,
    table: str,
    where_select: sql.Composable,
    where_delete: sql.Composable,
) -> None:
    """Заменить строки `public.<table>` на dst строками из src (DELETE → COPY)."""
    tbl = sql.Identifier("public", table)
    with dst.cursor() as dc:
        dc.execute(sql.SQL("DELETE FROM {} WHERE {}").format(tbl, where_delete))
    copy_out = sql.SQL("COPY (SELECT * FROM {} WHERE {}) TO STDOUT").format(tbl, where_select)
    with src.cursor().copy(copy_out) as out, dst.cursor() as dcur:
        with dcur.copy(sql.SQL("COPY {} FROM STDIN").format(tbl)) as inp:
            for block in out:
                inp.write(block)
        rows = dcur.rowcount
    shown = rows if rows >= 0 else "?"
    typer.echo(f"  · public.{table}: {shown} строк", err=True)


def seed_rows(
    src: psycopg.Connection,
    dst: psycopg.Connection,
    client_id: int,
    tables: tuple[str, ...],
    *,
    with_spreadsheets: bool,
    target_server: str = "sl-1",
) -> None:
    """Залить строку `clients` (server=target_server) + `tables` (+опц. spreadsheets) в dst."""
    with dst.cursor() as dc:
        # суперюзер локально → отключаем FK/триггеры, порядок таблиц неважен
        dc.execute(sql.SQL("SET session_replication_role = replica"))

    where_cid = sql.SQL("client_id = {}").format(sql.Literal(client_id))
    where_id = sql.SQL("id = {}").format(sql.Literal(client_id))

    # clients: строка клиента + server (клиент локально живёт на инстансе target_server)
    replace_rows(src, dst, "clients", where_id, where_id)
    with dst.cursor() as dc:
        dc.execute(
            sql.SQL("UPDATE public.clients SET server = {} WHERE id = {}").format(
                sql.Literal(target_server), sql.Literal(client_id)
            )
        )

    for table in tables:
        replace_rows(src, dst, table, where_cid, where_cid)

    if with_spreadsheets:
        src_ss = ss_ids(src, client_id)
        sel_ss = where_ss(src_ss)
        del_ss = where_ss(src_ss | ss_ids(dst, client_id))
        typer.echo(f"  · spreadsheets клиента: {len(src_ss)} листов", err=True)
        for table in SPREADSHEET_TABLES:
            replace_rows(src, dst, table, sel_ss, del_ss)

    dst.commit()


def schema_size(conn: PgConn, schema: str) -> str:
    """Кол-во таблиц + суммарный размер схемы на источнике — чтобы был понятен масштаб дампа.

    Best-effort: при любой ошибке возвращаем заглушку, копию не блокируем.
    """
    try:
        with conn.connect() as c, c.cursor() as cur:
            cur.execute(
                "SELECT count(*), pg_size_pretty(COALESCE(SUM("
                "pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))"
                "), 0)) FROM pg_tables WHERE schemaname = %s",
                (schema,),
            )
            row = cur.fetchone()
        if not row:
            return "размер неизвестен"
        return f"{row[0]} таблиц, {row[1]}"
    except Exception:
        return "размер неизвестен"


def schema_exists(conn: PgConn, schema: str) -> bool:
    """Есть ли `schema` на target. Best-effort: при ошибке считаем, что нет (восстановим)."""
    try:
        with conn.connect() as c, c.cursor() as cur:
            cur.execute(
                sql.SQL("SELECT 1 FROM information_schema.schemata WHERE schema_name = {}").format(
                    sql.Literal(schema)
                )
            )
            return cur.fetchone() is not None
    except Exception:
        return False


def dump_restore_schema(src_conn: PgConn, dst_conn: PgConn, schema: str, *, src_label: str) -> None:
    """Снять схему `schema` с источника и восстановить в dst (DROP CASCADE + pg_restore).

    Схема пересоздаётся из дампа целиком — если её на target не было, она создаётся
    (паритет с `make-schema`); если была, заменяется свежей копией источника.
    """
    size = schema_size(src_conn, schema)
    typer.echo(f"… {schema} на {src_label}: {size} — снимаю дамп (может быть долго)", err=True)
    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as f:
        path = Path(f.name)
    try:
        run_pg_tool(
            pg_dump_argv(
                src_conn, ["-n", schema, "--no-owner", "--no-privileges", "-f", str(path)]
            ),
            src_conn,
            f"pg_dump {schema}",
        )
        with dst_conn.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema))
                )
            conn.commit()
        run_pg_tool(
            pg_restore_argv(dst_conn, ["--no-owner", "--no-privileges"], path),
            dst_conn,
            f"pg_restore {schema}",
        )
    finally:
        path.unlink(missing_ok=True)


def grant_client_role(dst_conn: PgConn, client_id: int) -> None:
    """Завести роль `client_<id>` (если нет) и выдать ей права на `schema_<id>`.

    Локальный sl-back ходит в клиентскую схему per-client ролью `client_<id>`
    (`clientDB.getConnection`), а `pg_restore --no-privileges` прав не переносит —
    без этого гранта web видит «relation … does not exist». Идемпотентно. Пароль роли —
    `PG_CLIENT_USER_PASSWORD` из `~/.config/mpu/.env` (под ним коннектится clientDB).
    """
    role = f"client_{client_id}"
    schema = f"schema_{client_id}"
    with dst_conn.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql.SQL("SELECT 1 FROM pg_roles WHERE rolname = {}").format(sql.Literal(role))
            )
            if cur.fetchone() is None:
                password = servers.env_value("PG_CLIENT_USER_PASSWORD")
                if password:
                    cur.execute(
                        sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                            sql.Identifier(role), sql.Literal(password)
                        )
                    )
                else:
                    cur.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
            sch = sql.Identifier(schema)
            r = sql.Identifier(role)
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sch, r))
            cur.execute(
                sql.SQL("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA {} TO {}").format(sch, r)
            )
            cur.execute(
                sql.SQL("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA {} TO {}").format(sch, r)
            )
        conn.commit()
    typer.echo(f"  · права на {schema} выданы роли {role} (clientDB-доступ web)", err=True)


def copy_public_rows(
    src_conn: PgConn, dst_conn: PgConn, client_id: int, *, target_server: str = "sl-1"
) -> None:
    """Схема-связанные public-строки клиента → sl-1 (instance): loader_info, spreadsheets, …"""
    typer.echo(f"… public-строки клиента {client_id} → локальный sl-1 (instance)", err=True)
    with src_conn.connect() as src, dst_conn.connect() as dst:
        seed_rows(
            src,
            dst,
            client_id,
            CLIENT_ID_TABLES,
            with_spreadsheets=True,
            target_server=target_server,
        )
    typer.echo("  ✓ sl-1 public-строки готовы", err=True)


def copy_main_rows(src_conn: PgConn, dst_conn: PgConn, client_id: int) -> None:
    """Токен-строки клиента → sl-0 (main): clients/wb_tokens/clients_wb_cabinets — authoritative
    store, откуда wb-cabinet/clientsWbTokens читают (GET :sid/tokens, DELETE :sid/token)."""
    typer.echo(f"… токен-строки клиента {client_id} → локальный sl-0 (main)", err=True)
    with src_conn.connect() as src, dst_conn.connect() as dst:
        seed_rows(src, dst, client_id, MAIN_CLIENT_TABLES, with_spreadsheets=False)
    typer.echo("  ✓ sl-0 токен-строки готовы (wb-cabinet/clientsWbTokens читают отсюда)", err=True)
