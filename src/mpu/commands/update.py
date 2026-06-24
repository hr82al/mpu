"""`mpu update` — синхронизация локального SQLite со всеми серверами.

Стратегия:
1. main (sl-0): SELECT public.clients → авторитет по `(client_id, server)`.
2. Для каждого уникального server из списка клиентов: подключиться к pg_<N>,
   SELECT public.spreadsheets — это spreadsheets, физически живущие на этом инстансе.
3. Записать всё в локальный SQLite (DELETE+INSERT в одной транзакции на main, и
   накопительно по spreadsheets — DELETE один раз перед циклом, INSERT на каждый сервер).
"""

import time
from typing import Annotated, Any

import psycopg
import typer

from mpu.lib import loki_discover, pg, servers, store

COMMAND_NAME = "mpu update"
COMMAND_SUMMARY = "Синхронизировать кэш клиентов из sl-back"


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


def _fetch_wb_sids() -> list[tuple[Any, ...]]:
    """`(client_id, sid)` из public.wb_tokens на main (authoritative).

    DISTINCT — на один sid может быть несколько токенов. `sid` имеет тип uuid;
    приводим к str на этапе записи в SQLite.
    """
    with pg.connect_main() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT client_id, sid FROM public.wb_tokens WHERE sid IS NOT NULL")
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
        {n for row in clients if (n := servers.server_number(row[1])) is not None and n > 0}
    )

    spreadsheets_per_server: dict[int, list[tuple[Any, ...]]] = {}
    failed_servers: list[tuple[int, str]] = []
    for n in server_numbers:
        try:
            spreadsheets_per_server[n] = _fetch_spreadsheets_for_server(n)
        except (psycopg.Error, OSError, pg.PgConfigError) as e:
            failed_servers.append((n, str(e).splitlines()[0]))

    total_spreadsheets = sum(len(v) for v in spreadsheets_per_server.values())

    # client_id → server (sl-N) для проставления server у sid-строк.
    server_by_client: dict[Any, str] = {row[0]: row[1] for row in clients}
    wb_sid_rows = _fetch_wb_sids()
    sid_rows: list[tuple[str, Any, str, int]] = [
        (str(sid), client_id, server_by_client[client_id], synced_at)
        for client_id, sid in wb_sid_rows
        if client_id in server_by_client
    ]

    with store.store() as conn:
        # Идемпотентный self-heal схемы: на кэшах, забутстрапленных старым
        # `mpu init`, ещё нет `sl_wb_sids` — добьём недостающие таблицы, чтобы
        # `mpu update` не падал на `DELETE FROM sl_wb_sids` (CREATE IF NOT EXISTS).
        store.bootstrap(conn)
        with conn:
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
            conn.execute("DELETE FROM sl_wb_sids")
            conn.executemany(
                "INSERT OR REPLACE INTO sl_wb_sids (sid, client_id, server, synced_at) "
                "VALUES (?, ?, ?, ?)",
                sid_rows,
            )

    # Дополнительно — обновить Loki-кэш для shell completion (hosts/services).
    # Best-effort: пропускаем если LOKI_URL не задан или Loki недоступен.
    loki_result = loki_discover.discover_and_store()

    elapsed = time.monotonic() - started
    if not quiet:
        n_servers = len(spreadsheets_per_server)
        typer.echo(
            f"clients: {len(clients)} rows, "
            f"spreadsheets: {total_spreadsheets} rows from {n_servers} servers, "
            f"wb sids: {len(sid_rows)} rows, "
            f"took {elapsed:.2f}s"
        )
        if loki_result.error:
            typer.echo(f"loki: пропущено ({loki_result.error})", err=True)
        else:
            n_services = sum(len(v) for v in loki_result.services_by_host.values())
            typer.echo(f"loki: {len(loki_result.hosts)} hosts, {n_services} (host, service) пар")
        if failed_servers:
            typer.echo(
                "warning: failed to query servers: "
                + ", ".join(f"sl-{n} ({err})" for n, err in failed_servers),
                err=True,
            )
    return len(clients), total_spreadsheets, elapsed


def fetch_single_client(client_id: int) -> bool:
    """Точечно подтянуть одного клиента (его spreadsheets + WB sids) в локальный кэш.

    Для свежих web-клиентов, которых ещё нет в снапшоте `mpu update` (резолв email
    через 10X может дать client_id раньше, чем общий sync). Возвращает True, если
    клиент найден на main; False — если не найден или main недоступен. Ошибки PG —
    best-effort: что удалось прочитать, то и кладём (sids/ss могут деградировать в []).
    """
    synced_at = int(time.time())
    try:
        with pg.connect_main() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, server, is_active, is_locked, is_deleted "
                "FROM public.clients WHERE id = %s",
                (client_id,),
            )
            client_row = cur.fetchone()
    except (psycopg.Error, OSError, pg.PgConfigError):
        return False
    if client_row is None:
        return False

    server = client_row[1]
    n = servers.server_number(server)

    ss_rows: list[tuple[Any, ...]] = []
    if n is not None and n > 0:
        try:
            with pg.connect_to(n) as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT client_id, spreadsheet_id, title, template_name, is_active "
                    "FROM public.spreadsheets WHERE client_id = %s",
                    (client_id,),
                )
                ss_rows = list(cur.fetchall())
        except (psycopg.Error, OSError, pg.PgConfigError):
            ss_rows = []

    sid_rows: list[tuple[Any, ...]] = []
    try:
        with pg.connect_main() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT client_id, sid FROM public.wb_tokens "
                "WHERE client_id = %s AND sid IS NOT NULL",
                (client_id,),
            )
            sid_rows = list(cur.fetchall())
    except (psycopg.Error, OSError, pg.PgConfigError):
        sid_rows = []

    server_name = f"sl-{n}" if n is not None and n > 0 else server
    with store.store() as conn:
        store.bootstrap(conn)
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO sl_clients "
                "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    client_row[0],
                    server,
                    1 if client_row[2] else 0,
                    1 if client_row[3] else 0,
                    1 if client_row[4] else 0,
                    synced_at,
                ),
            )
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
            conn.executemany(
                "INSERT OR REPLACE INTO sl_wb_sids (sid, client_id, server, synced_at) "
                "VALUES (?, ?, ?, ?)",
                [(str(sid), cid, server, synced_at) for cid, sid in sid_rows],
            )
    return True


app = typer.Typer(
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    quiet: Annotated[bool, typer.Option("--quiet", help="Не печатать summary")] = False,
) -> None:
    """Синхронизировать ~/.config/mpu/mpu.db со всеми PG-серверами."""
    run_update(quiet=quiet)
