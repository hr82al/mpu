"""`mpu search` — поиск spreadsheet/клиента в локальном SQLite-кэше.

Селектор:
  - `client_id` (целое) — точный match.
  - IPv4 (`192.168.150.31`) — резолв через `sl_<N>` / `pg_<N>` из
    `~/.config/mpu/.env` в синтетический row с `server_number=N` (без клиентов).
  - `spreadsheet_id` substring — case-insensitive.
  - `title` substring — case-insensitive (только если `spreadsheet_id` не нашёл).
"""

import json
import re
import sqlite3
from typing import Annotated, TypeGuard

import typer

from mpu.lib import servers, store

COMMAND_NAME = "mpu search"
COMMAND_SUMMARY = "Поиск клиента / spreadsheet в локальном кэше"


def _sids_for_client(conn: sqlite3.Connection, client_id: object) -> list[str]:
    """Все WB sid клиента из локального кэша (отсортированы). Пусто → `[]`.

    Таблица `sl_wb_sids` добавлена позже остальной схемы — на кэшах,
    забутстрапленных старым `mpu init`, её ещё нет. Тогда деградируем в `[]`
    (резолв селектора не должен падать); схема дотянется на следующем
    `mpu update` / `mpu init`.
    """
    if client_id is None:
        return []
    try:
        cur = conn.execute(
            "SELECT sid FROM sl_wb_sids WHERE client_id = ? ORDER BY sid",
            (client_id,),
        )
    except sqlite3.OperationalError:
        return []
    return [r["sid"] for r in cur.fetchall()]


def _row_to_result(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, object]:
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
        "sids": _sids_for_client(conn, row["client_id"]),
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
    return [_row_to_result(conn, r) for r in cur.fetchall()]


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
    return [_row_to_result(conn, r) for r in cur.fetchall()]


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
    return [_row_to_result(conn, r) for r in cur.fetchall()]


def _is_int(value: str) -> bool:
    s = value.lstrip("-")
    return bool(s) and s.isdigit()


_IPV4_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


def _looks_like_ip(value: str) -> bool:
    return bool(_IPV4_RE.match(value))


def _by_ip(value: str) -> list[dict[str, object]]:
    n = servers.server_number_by_ip(value)
    if n is None:
        return []
    return [
        {
            "client_id": None,
            "spreadsheet_id": None,
            "title": None,
            "server": f"sl-{n}",
            "server_number": n,
            "sl_ip": servers.sl_ip(n),
            "pg_ip": servers.pg_ip(n),
            "sids": [],
        }
    ]


def _by_sid(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    """sid → клиент(ы). Сначала точное совпадение, иначе substring (LIKE %v%).

    Возвращает строки клиента так же, как `_by_client_id` (со spreadsheets и
    полным списком `sids`), чтобы контракт результата был единым.
    """

    def _client_ids(where: str, param: str) -> list[object]:
        # sl_wb_sids может отсутствовать на старом кэше (см. _sids_for_client) —
        # тогда sid-матч просто пустой, search падает дальше на ss_id/title.
        try:
            cur = conn.execute(
                f"SELECT DISTINCT client_id FROM sl_wb_sids WHERE {where} ORDER BY client_id",
                (param,),
            )
        except sqlite3.OperationalError:
            return []
        return [r["client_id"] for r in cur.fetchall()]

    client_ids = _client_ids("sid = ?", value) or _client_ids("sid LIKE ?", f"%{value}%")
    out: list[dict[str, object]] = []
    for cid in client_ids:
        if isinstance(cid, int):
            out.extend(_by_client_id(conn, cid))
    return out


def search(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    """Однопроходный поиск. Порядок: client_id → IP → sid → ss_id → title.

    `sid` (exact, затем substring) идёт перед ss_id/title — sid'ы из
    `sl_wb_sids` достаточно специфичны; если ничего не нашли — fallback дальше.
    """
    if _is_int(value):
        return _by_client_id(conn, int(value))
    if _looks_like_ip(value):
        return _by_ip(value)
    by_sid = _by_sid(conn, value)
    if by_sid:
        return by_sid
    found = _by_spreadsheet_id(conn, value)
    if found:
        return found
    return _by_title(conn, value)


def _is_str_list(o: object) -> TypeGuard[list[str]]:
    """Явный type-guard (CLAUDE.md §5). `sids` по построению — list[str]
    (`_sids_for_client` тянет TEXT-колонку), поэтому достаточно проверки list."""
    return isinstance(o, list)


def _project(results: list[dict[str, object]], field: str) -> list[str]:
    if field == "sids":
        # Список → одна строка через запятую (одна строка на result-row).
        out: list[str] = []
        for r in results:
            v = r.get(field)
            out.append(",".join(v) if _is_str_list(v) else "")
        return out
    return ["" if r.get(field) is None else str(r.get(field)) for r in results]


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: Annotated[
        str,
        typer.Argument(
            help=(
                "client_id (число), IPv4 (sl_/pg_ из .env), WB sid "
                "(точное/substring), кусок spreadsheet_id или title"
            ),
        ),
    ],
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
    sids: Annotated[
        bool, typer.Option("--sids", help="Plain: WB sid'ы клиента через запятую")
    ] = False,
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
    автоматически вызывает `mpu update` и повторяет поиск (отключается через `--no-update`).
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
            ("sids", sids),
        ]
        if flag
    ]
    if len(chosen) > 1:
        typer.echo("mpu search: only one projection flag allowed", err=True)
        raise typer.Exit(code=2)

    with store.store() as conn:
        results = search(conn, value)
        # IP резолвится из ~/.config/mpu/.env, а не из SQLite — `mpu update` не поможет.
        if not results and update and not _looks_like_ip(value):
            # lazy import — тесты search-логики не должны тянуть psycopg.
            from mpu.commands import update as update_cmd

            update_cmd.run_update(quiet=True)
            results = search(conn, value)

    if chosen:
        for line in _project(results, chosen[0]):
            typer.echo(line)
        return

    typer.echo(json.dumps(results, ensure_ascii=False, indent=2))
