"""`mpu copy-dev [client_id]` — скопировать данные с dev-стенда в локальный docker-стек.

- **Без аргумента** → вся БД `workspaces` (sw-back) dev → локальный `mp-sw-pg`.
- **`copy-dev <id>`** → схема `schema_<id>` + public-строки клиента из `mp_sl_1_dev`
  → локальный `mp-sl-1-pg`.

Копирование — обычные `pg_dump`/`pg_restore` + psycopg `COPY` (НЕ dt-host/clientsTransfer:
dev на отдельном сервере, dt-host тут не подходит). Реквизиты — из `~/.config/mpu/.env`:
dev sl — `PG_MAIN_USER_NAME`+`PG_PASSWORD`; dev workspaces — `DEV_WORKSPACES_USER`/
`DEV_WORKSPACES_PASSWORD`. Локальный sl коннектится суперюзером (`wb_plus_db_admin`,
pgbouncer off), поэтому схему восстанавливаем `--no-owner --no-privileges`, а public-строки
грузим под `session_replication_role = replica` (без возни с порядком FK).

Набор public-таблиц одного клиента — зеркало стадий `clientsTransfer.service.js`.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated

import psycopg
import typer
from psycopg import sql

from mpu.lib import pg
from mpu.lib.pg import PgConfigError, PgConn

COMMAND_NAME = "mpu copy-dev"
COMMAND_SUMMARY = "Скопировать workspaces / клиента с dev в локальный docker-стек (pg_dump)"

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

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _run_pg_tool(argv: list[str], conn: PgConn, label: str) -> None:
    """Прогнать `pg_dump`/`pg_restore` c PGPASSWORD из conn; упасть на ненулевом коде."""
    env = {**os.environ, "PGPASSWORD": conn.password}
    typer.echo(f"$ {' '.join(argv)}", err=True)
    rc = subprocess.run(argv, env=env, check=False).returncode
    if rc != 0:
        typer.echo(f"{COMMAND_NAME}: {label} failed (exit {rc})", err=True)
        raise typer.Exit(code=1)


def _pg_dump_argv(conn: PgConn, extra: list[str]) -> list[str]:
    return [
        "pg_dump",
        "-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.dbname,
        "-Fc",
        *extra,
    ]


def _pg_restore_argv(conn: PgConn, extra: list[str], path: Path) -> list[str]:
    return [
        "pg_restore",
        "-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.dbname,
        *extra,
        str(path),
    ]


def _ss_ids(conn: psycopg.Connection, client_id: int) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL("SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id = {}").format(
                sql.Literal(client_id)
            )
        )
        return {row[0] for row in cur.fetchall()}


def _where_ss(ids: set[str]) -> sql.Composable:
    if not ids:
        return sql.SQL("false")
    return sql.SQL("spreadsheet_id IN ({})").format(
        sql.SQL(", ").join(sql.Literal(v) for v in sorted(ids))
    )


def _replace_rows(
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
    with (
        src.cursor().copy(copy_out) as out,
        dst.cursor().copy(sql.SQL("COPY {} FROM STDIN").format(tbl)) as inp,
    ):
        for block in out:
            inp.write(block)


def _copy_public_rows(src_conn: PgConn, dst_conn: PgConn, client_id: int) -> None:
    with src_conn.connect() as src, dst_conn.connect() as dst:
        with dst.cursor() as dc:
            # суперюзер локально → отключаем FK/триггеры, порядок таблиц неважен
            dc.execute(sql.SQL("SET session_replication_role = replica"))

        where_cid = sql.SQL("client_id = {}").format(sql.Literal(client_id))
        where_id = sql.SQL("id = {}").format(sql.Literal(client_id))

        # clients: строка клиента + server='sl-1'
        _replace_rows(src, dst, "clients", where_id, where_id)
        with dst.cursor() as dc:
            dc.execute(
                sql.SQL("UPDATE public.clients SET server = 'sl-1' WHERE id = {}").format(
                    sql.Literal(client_id)
                )
            )

        for table in CLIENT_ID_TABLES:
            _replace_rows(src, dst, table, where_cid, where_cid)

        dev_ss = _ss_ids(src, client_id)
        sel_ss = _where_ss(dev_ss)
        del_ss = _where_ss(dev_ss | _ss_ids(dst, client_id))
        for table in SPREADSHEET_TABLES:
            _replace_rows(src, dst, table, sel_ss, del_ss)

        dst.commit()


def _copy_client(client_id: int) -> None:
    src = pg.dev_sl_conn()
    dst = pg.local_sl_conn()
    schema = f"schema_{client_id}"

    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as f:
        path = Path(f.name)
    try:
        _run_pg_tool(
            _pg_dump_argv(src, ["-n", schema, "--no-owner", "--no-privileges", "-f", str(path)]),
            src,
            f"pg_dump {schema}",
        )
        with dst.connect() as conn:
            with conn.cursor() as cur:
                drop = sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema))
                cur.execute(drop)
            conn.commit()
        _run_pg_tool(
            _pg_restore_argv(dst, ["--no-owner", "--no-privileges"], path),
            dst,
            f"pg_restore {schema}",
        )
    finally:
        path.unlink(missing_ok=True)

    _copy_public_rows(src, dst, client_id)
    typer.echo(
        f"✓ client {client_id}: схема + public-строки скопированы в локальный sl-1. "
        f"Данные готовы (пересчёт не нужен). При залипшем кэше: "
        f"docker exec redis-dev redis-cli -a some-redis-password FLUSHALL"
    )


def _copy_workspaces() -> None:
    src = pg.dev_workspaces_conn()
    dst = pg.local_workspaces_conn()

    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as f:
        path = Path(f.name)
    try:
        _run_pg_tool(
            _pg_dump_argv(src, ["--no-owner", "--no-acl", "-f", str(path)]),
            src,
            "pg_dump workspaces",
        )
        _run_pg_tool(
            _pg_restore_argv(dst, ["--clean", "--if-exists", "--no-owner", "--no-acl"], path),
            dst,
            "pg_restore workspaces",
        )
    finally:
        path.unlink(missing_ok=True)
    typer.echo(
        "✓ workspaces скопирована в локальный mp-sw-pg. "
        "Перезапусти api (`sw-back-up`) — entrypoint накатит prisma migrate deploy."
    )


@app.command()
def main(
    client_id: Annotated[
        int | None,
        typer.Argument(help="client_id для копии sl-схемы; без аргумента — вся БД workspaces"),
    ] = None,
) -> None:
    """Скопировать данные с dev в локальный docker-стек (`pg_dump`/`pg_restore`)."""
    try:
        if client_id is None:
            _copy_workspaces()
        else:
            _copy_client(client_id)
    except PgConfigError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        raise typer.Exit(code=2) from None
