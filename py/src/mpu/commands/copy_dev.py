"""`mpu copy-dev [client_id]` — скопировать данные с dev-стенда в локальный docker-стек.

- **Без аргумента** → вся БД `workspaces` (sw-back) dev → локальный `mp-sw-pg`.
- **`copy-dev <id>`** → схема `schema_<id>` + public-строки клиента из `mp_sl_1_dev`
  → локальный `mp-sl-1-pg`.

Копирование — обычные `pg_dump`/`pg_restore` + psycopg `COPY` (НЕ dt-host/clientsTransfer:
dev на отдельном сервере, dt-host тут не подходит). Машинерия копии общая с `copy-client`
и живёт в `lib/pg_copy.py`; здесь — только резолв dev-реквизитов и порядок шагов.
Реквизиты — из `~/.config/mpu/.env`: dev sl — `PG_MAIN_USER_NAME`+`PG_PASSWORD`; dev
workspaces — `DEV_WORKSPACES_USER`/`DEV_WORKSPACES_PASSWORD`.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import pg, pg_copy
from mpu.lib.pg import PgConfigError

COMMAND_NAME = "mpu copy-dev"
COMMAND_SUMMARY = "Скопировать workspaces / клиента с dev в локальный docker-стек (pg_dump)"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _copy_client(client_id: int) -> None:
    src = pg.dev_sl_conn()
    dst = pg.local_sl_conn()
    main_dst = pg.local_main_conn()
    schema = f"schema_{client_id}"
    pg_copy.dump_restore_schema(src, dst, schema, src_label="dev")
    pg_copy.grant_client_role(dst, client_id)
    pg_copy.copy_public_rows(src, dst, client_id)
    pg_copy.copy_main_rows(src, main_dst, client_id)
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
        pg_copy.run_pg_tool(
            pg_copy.pg_dump_argv(src, ["--no-owner", "--no-acl", "-f", str(path)]),
            src,
            "pg_dump workspaces",
        )
        pg_copy.run_pg_tool(
            pg_copy.pg_restore_argv(
                dst, ["--clean", "--if-exists", "--no-owner", "--no-acl"], path
            ),
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
