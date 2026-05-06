"""`mpu-update` — синхронизация локального SQLite со всеми серверами.

Стратегия:
1. main (sl-0): SELECT public.clients → авторитет по `(client_id, server)`.
2. Для каждого уникального server из списка клиентов: подключиться к pg_<N>,
   SELECT public.spreadsheets — это spreadsheets, физически живущие на этом инстансе.
3. Записать всё в локальный SQLite (DELETE+INSERT в одной транзакции на main, и
   накопительно по spreadsheets — DELETE один раз перед циклом, INSERT на каждый сервер).
"""

import re
import time
from typing import Annotated, Any

import typer

from mpu.lib import pg, store


def _server_to_number(server: str | None) -> int | None:
    if not server:
        return None
    m = re.fullmatch(r"sl-(\d+)", server)
    return int(m.group(1)) if m else None


def _fetch_clients() -> list[tuple[Any, ...]]:
    with pg.connect_main() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, server, is_active, is_locked, is_deleted FROM public.clients")
        return list(cur.fetchall())


def _fetch_spreadsheets_for_server(n: int) -> list[tuple[Any, ...]]:
    with pg.connect_to(n) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT client_id, spreadsheet_id, title, template_name, is_active "
            "FROM public.spreadsheets"
        )
        return list(cur.fetchall())


def run_update(quiet: bool = False) -> tuple[int, int, float]:
    """Перезаписать `sl_clients` и `sl_spreadsheets` свежими данными.

    Возвращает `(clients_count, spreadsheets_count, elapsed_seconds)`.
    """
    started = time.monotonic()
    synced_at = int(time.time())

    clients = _fetch_clients()

    # Уникальные сервера, на которых живут активные клиенты (sl-1, sl-2, ...).
    server_numbers: list[int] = sorted(
        {n for row in clients if (n := _server_to_number(row[1])) is not None and n > 0}
    )

    spreadsheets_per_server: dict[int, list[tuple[Any, ...]]] = {}
    failed_servers: list[tuple[int, str]] = []
    for n in server_numbers:
        try:
            spreadsheets_per_server[n] = _fetch_spreadsheets_for_server(n)
        except Exception as e:
            failed_servers.append((n, str(e).splitlines()[0]))

    total_spreadsheets = sum(len(v) for v in spreadsheets_per_server.values())

    with store.store() as conn:
        conn.execute("BEGIN")
        try:
            conn.execute("DELETE FROM sl_clients")
            conn.executemany(
                "INSERT INTO sl_clients "
                "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        row[0],
                        row[1],
                        1 if row[2] else 0,
                        1 if row[3] else 0,
                        1 if row[4] else 0,
                        synced_at,
                    )
                    for row in clients
                ],
            )
            conn.execute("DELETE FROM sl_spreadsheets")
            for n, ss_rows in spreadsheets_per_server.items():
                server_name = f"sl-{n}"
                conn.executemany(
                    "INSERT OR REPLACE INTO sl_spreadsheets "
                    "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [
                        (
                            row[1],
                            row[0],
                            row[2] or "",
                            row[3],
                            1 if row[4] else 0,
                            server_name,
                            synced_at,
                        )
                        for row in ss_rows
                    ],
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    elapsed = time.monotonic() - started
    if not quiet:
        n_servers = len(spreadsheets_per_server)
        typer.echo(
            f"clients: {len(clients)} rows, "
            f"spreadsheets: {total_spreadsheets} rows from {n_servers} servers, "
            f"took {elapsed:.2f}s"
        )
        if failed_servers:
            typer.echo(
                "warning: failed to query servers: "
                + ", ".join(f"sl-{n} ({err})" for n, err in failed_servers),
                err=True,
            )
    return len(clients), total_spreadsheets, elapsed


app = typer.Typer(add_completion=False)


@app.command()
def main(
    quiet: Annotated[bool, typer.Option("--quiet", help="Не печатать summary")] = False,
) -> None:
    """Синхронизировать ~/.config/mpu/mpu.db со всеми PG-серверами."""
    run_update(quiet=quiet)


def run() -> None:
    """Entry point для `mpu-update`."""
    app()
