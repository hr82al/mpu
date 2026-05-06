"""`mpu-search` — поиск spreadsheet/клиента в локальном SQLite-кэше."""

import json
import sqlite3
from typing import Annotated

import typer

from mpu.lib import servers, store

COMMAND_NAME = "mpu-search"
COMMAND_SUMMARY = "Поиск клиента / spreadsheet в локальном кэше"


def _row_to_result(row: sqlite3.Row) -> dict[str, object]:
    server = row["server"]
    n = servers.server_number(server)
    return {
        "client_id": row["client_id"],
        "spreadsheet_id": row["ss_id"],
        "title": row["title"],
        "server": server,
        "server_number": n,
        "sl_ip": servers.sl_ip(n) if n is not None else None,
        "pg_ip": servers.pg_ip(n) if n is not None else None,
    }


def _by_client_id(conn: sqlite3.Connection, value: int) -> list[dict[str, object]]:
    # LEFT JOIN: клиент без spreadsheet тоже найдётся (одной строкой с null'ами).
    cur = conn.execute(
        """
        SELECT
            c.client_id           AS client_id,
            s.ss_id               AS ss_id,
            s.title               AS title,
            COALESCE(s.server, c.server) AS server
        FROM sl_clients c
        LEFT JOIN sl_spreadsheets s ON s.client_id = c.client_id
        WHERE c.client_id = ?
        ORDER BY s.ss_id
        """,
        (value,),
    )
    return [_row_to_result(r) for r in cur.fetchall()]


def _by_spreadsheet_id(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    cur = conn.execute(
        """
        SELECT s.client_id, s.ss_id, s.title, s.server
        FROM sl_spreadsheets s
        WHERE LOWER(s.ss_id) LIKE LOWER(?)
        ORDER BY s.ss_id
        """,
        (f"%{value}%",),
    )
    return [_row_to_result(r) for r in cur.fetchall()]


def _by_title(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    cur = conn.execute(
        """
        SELECT s.client_id, s.ss_id, s.title, s.server
        FROM sl_spreadsheets s
        WHERE LOWER(s.title) LIKE LOWER(?)
        ORDER BY s.title, s.ss_id
        """,
        (f"%{value}%",),
    )
    return [_row_to_result(r) for r in cur.fetchall()]


def _is_int(value: str) -> bool:
    s = value.lstrip("-")
    return bool(s) and s.isdigit()


def search(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    """Однопроходный поиск по правилам из плана (без auto-update fallback)."""
    if _is_int(value):
        return _by_client_id(conn, int(value))
    found = _by_spreadsheet_id(conn, value)
    if found:
        return found
    return _by_title(conn, value)


def _project(results: list[dict[str, object]], field: str) -> list[str]:
    return ["" if r.get(field) is None else str(r.get(field)) for r in results]


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: Annotated[str, typer.Argument(help="client_id (число), кусок spreadsheet_id или title")],
    client_id: Annotated[bool, typer.Option("--client-id", help="Plain: только client_id")] = False,
    spreadsheet_id: Annotated[
        bool, typer.Option("--spreadsheet-id", help="Plain: только spreadsheet_id")
    ] = False,
    title: Annotated[bool, typer.Option("--title", help="Plain: только title")] = False,
    server: Annotated[
        bool, typer.Option("--server", help="Plain: только server name (sl-N)")
    ] = False,
    server_number: Annotated[
        bool, typer.Option("--server-number", help="Plain: только число N")
    ] = False,
    sl_ip: Annotated[bool, typer.Option("--sl-ip", help="Plain: только IP sl-сервера")] = False,
    pg_ip: Annotated[bool, typer.Option("--pg-ip", help="Plain: только IP pg-сервера")] = False,
    update: Annotated[
        bool,
        typer.Option(
            "--update/--no-update",
            help="Auto-update кэша на пустом результате (default: on)",
        ),
    ] = True,
) -> None:
    """Поиск по локальному ~/.config/mpu/mpu.db.

    По умолчанию — JSON-array строк со всеми полями. На пустом результате
    автоматически вызывает `mpu-update` и повторяет поиск (отключается через `--no-update`).
    """
    chosen = [
        name
        for name, flag in [
            ("client_id", client_id),
            ("spreadsheet_id", spreadsheet_id),
            ("title", title),
            ("server", server),
            ("server_number", server_number),
            ("sl_ip", sl_ip),
            ("pg_ip", pg_ip),
        ]
        if flag
    ]
    if len(chosen) > 1:
        typer.echo("mpu-search: only one projection flag allowed", err=True)
        raise typer.Exit(code=2)

    with store.store() as conn:
        results = search(conn, value)
        if not results and update:
            # lazy import — тесты search-логики не должны тянуть psycopg.
            from mpu.commands import update as update_cmd

            update_cmd.run_update(quiet=True)
            results = search(conn, value)

    if chosen:
        for line in _project(results, chosen[0]):
            typer.echo(line)
        return

    typer.echo(json.dumps(results, ensure_ascii=False, indent=2))


def run() -> None:
    """Entry point для `mpu-search`."""
    app()
