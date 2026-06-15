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
import threading
import time
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
# токен-строки на sl-0/main: authoritative store, откуда wb-cabinet/clientsWbTokens читают
# (`listCabinetTokensMetadata`/`removeCabinetTokens` + HTTP `/v1/cabinet/*`). Instance (sl-1) —
# read-only реплика wb_tokens, поэтому для проверки токен-флоу нужны строки именно на main.
MAIN_CLIENT_TABLES = (
    "wb_tokens",
    "clients_wb_cabinets",
)

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _run_pg_tool(argv: list[str], conn: PgConn, label: str, heartbeat: float = 10.0) -> None:
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
        typer.echo(f"{COMMAND_NAME}: {label} failed (exit {rc}, {elapsed}s)", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"  ✓ {label}: готово за {elapsed}s", err=True)


def _pg_dump_argv(conn: PgConn, extra: list[str]) -> list[str]:
    return [
        "pg_dump",
        "-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.dbname,
        "-Fc", "--verbose",
        *extra,
    ]


def _pg_restore_argv(conn: PgConn, extra: list[str], path: Path) -> list[str]:
    return [
        "pg_restore",
        "-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.dbname,
        "--verbose",
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
    with src.cursor().copy(copy_out) as out, dst.cursor() as dcur:
        with dcur.copy(sql.SQL("COPY {} FROM STDIN").format(tbl)) as inp:
            for block in out:
                inp.write(block)
        rows = dcur.rowcount
    shown = rows if rows >= 0 else "?"
    typer.echo(f"  · public.{table}: {shown} строк", err=True)


def _seed_rows(
    src: psycopg.Connection,
    dst: psycopg.Connection,
    client_id: int,
    tables: tuple[str, ...],
    *,
    with_spreadsheets: bool,
) -> None:
    """Залить строку `clients` (server='sl-1') + `tables` (+опц. spreadsheets) клиента в dst."""
    with dst.cursor() as dc:
        # суперюзер локально → отключаем FK/триггеры, порядок таблиц неважен
        dc.execute(sql.SQL("SET session_replication_role = replica"))

    where_cid = sql.SQL("client_id = {}").format(sql.Literal(client_id))
    where_id = sql.SQL("id = {}").format(sql.Literal(client_id))

    # clients: строка клиента + server='sl-1' (клиент живёт на инстансе sl-1)
    _replace_rows(src, dst, "clients", where_id, where_id)
    with dst.cursor() as dc:
        dc.execute(
            sql.SQL("UPDATE public.clients SET server = 'sl-1' WHERE id = {}").format(
                sql.Literal(client_id)
            )
        )

    for table in tables:
        _replace_rows(src, dst, table, where_cid, where_cid)

    if with_spreadsheets:
        dev_ss = _ss_ids(src, client_id)
        sel_ss = _where_ss(dev_ss)
        del_ss = _where_ss(dev_ss | _ss_ids(dst, client_id))
        typer.echo(f"  · spreadsheets клиента: {len(dev_ss)} листов", err=True)
        for table in SPREADSHEET_TABLES:
            _replace_rows(src, dst, table, sel_ss, del_ss)

    dst.commit()


def _copy_public_rows(src_conn: PgConn, dst_conn: PgConn, client_id: int) -> None:
    """Схема-связанные public-строки клиента → sl-1 (instance): loader_info, spreadsheets, …"""
    typer.echo(f"… public-строки клиента {client_id} → локальный sl-1 (instance)", err=True)
    with src_conn.connect() as src, dst_conn.connect() as dst:
        _seed_rows(src, dst, client_id, CLIENT_ID_TABLES, with_spreadsheets=True)
    typer.echo("  ✓ sl-1 public-строки готовы", err=True)


def _copy_main_rows(src_conn: PgConn, dst_conn: PgConn, client_id: int) -> None:
    """Токен-строки клиента → sl-0 (main): clients/wb_tokens/clients_wb_cabinets — authoritative
    store, откуда wb-cabinet/clientsWbTokens читают (GET :sid/tokens, DELETE :sid/token)."""
    typer.echo(f"… токен-строки клиента {client_id} → локальный sl-0 (main)", err=True)
    with src_conn.connect() as src, dst_conn.connect() as dst:
        _seed_rows(src, dst, client_id, MAIN_CLIENT_TABLES, with_spreadsheets=False)
    typer.echo("  ✓ sl-0 токен-строки готовы (wb-cabinet/clientsWbTokens читают отсюда)", err=True)


def _schema_size(conn: PgConn, schema: str) -> str:
    """Кол-во таблиц + суммарный размер схемы на dev — чтобы был понятен масштаб дампа.

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


def _copy_client(client_id: int) -> None:
    src = pg.dev_sl_conn()
    dst = pg.local_sl_conn()
    main_dst = pg.local_main_conn()
    schema = f"schema_{client_id}"
    typer.echo(
        f"… {schema} на dev: {_schema_size(src, schema)} — снимаю дамп (может быть долго)",
        err=True,
    )

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
    _copy_main_rows(src, main_dst, client_id)
    typer.echo(
        f"✓ client {client_id}: схема + public-строки → sl-1, токен-строки → sl-0. "
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
