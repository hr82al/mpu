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
import time
from datetime import date
from typing import Annotated, TypeGuard, cast

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


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def looks_like_email(value: str) -> bool:
    return bool(_EMAIL_RE.match(value))


def _owned_ids(row: sqlite3.Row) -> list[int]:
    """`owned_client_ids` (JSON [int]) из строки `x10_email_clients`."""
    try:
        parsed = json.loads(row["owned_client_ids"])
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    # owned_client_ids пишется нами как JSON list[int] (см. x10_resolve._upsert_email_client)
    items: list[object] = cast("list[object]", parsed)
    return [c for c in items if isinstance(c, int)]


def _get_email_client_row(conn: sqlite3.Connection, email: str) -> sqlite3.Row | None:
    """Строка кэша email→client (lower-case email) или `None`. Нет таблицы → `None`."""
    try:
        cur = conn.execute(
            "SELECT email, target_user_id, target_name, is_email_verified, "
            "owned_client_ids, workspaces_json, reason, fetched_at "
            "FROM x10_email_clients WHERE email = ?",
            (email,),
        )
    except sqlite3.OperationalError:
        return None
    return cur.fetchone()


def _by_email(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    """email → owned client_id(ы) → строки клиента. ТОЛЬКО из кэша `x10_email_clients`.

    Cache-miss → `[]`: сам fetch через 10X API делает ТОЛЬКО `mpu search` (не
    shared-резолв), резолвер на miss бросает подсказку «сначала mpu search <email>».
    """
    row = _get_email_client_row(conn, value.lower())
    if row is None:
        return []
    out: list[dict[str, object]] = []
    for cid in _owned_ids(row):
        out.extend(_by_client_id(conn, cid))
    return out


def search(conn: sqlite3.Connection, value: str) -> list[dict[str, object]]:
    """Однопроходный поиск. Порядок: email → client_id → IP → sid → ss_id → title.

    `email` — cache-only (через `_by_email`); `sid` (exact, затем substring) идёт
    перед ss_id/title — sid'ы из `sl_wb_sids` достаточно специфичны; если ничего
    не нашли — fallback дальше.
    """
    if looks_like_email(value):
        return _by_email(conn, value)
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


def _bare_client_row(client_id: int) -> dict[str, object]:
    """owned client_id, которого нет в локальном снапшоте (свежий web-клиент, не
    подтянулся даже точечно) — показываем «голым», без server/ss/sids."""
    return {
        "client_id": client_id,
        "spreadsheet_id": None,
        "title": None,
        "server": None,
        "server_number": None,
        "sl_ip": None,
        "pg_ip": None,
        "sids": [],
    }


def _owned_rows(conn: sqlite3.Connection, row: sqlite3.Row) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for cid in _owned_ids(row):
        rows = _by_client_id(conn, cid)
        out.extend(rows if rows else [_bare_client_row(cid)])
    return out


def _sessions_for(conn: sqlite3.Connection, target_user_id: str) -> list[dict[str, object]]:
    """Кэшированные 10X-сессии (`x10_sessions`): staff + impersonation целевого юзера.
    Токен показываем целиком — он переиспользуем для ручных вызовов 10X API."""
    try:
        cur = conn.execute(
            "SELECT kind, subject, token, reason, created_at, expires_at FROM x10_sessions "
            "WHERE kind = 'staff' OR (kind = 'impersonation' AND subject = ?) ORDER BY kind",
            (str(target_user_id),),
        )
    except sqlite3.OperationalError:
        return []
    now = int(time.time())
    out: list[dict[str, object]] = []
    for r in cur.fetchall():
        out.append(
            {
                "kind": r["kind"],
                "subject": r["subject"],
                "reason": r["reason"],
                "created_at": r["created_at"],
                "expires_at": r["expires_at"],
                "valid": int(r["expires_at"]) > now,
                "token": r["token"],
            }
        )
    return out


def _email_output_obj(
    conn: sqlite3.Connection, row: sqlite3.Row, owned_rows: list[dict[str, object]]
) -> dict[str, object]:
    """Полный объект для дефолтного вывода `mpu search <email>` — показать ВСЁ."""
    try:
        parsed = json.loads(row["workspaces_json"])
    except (ValueError, TypeError):
        parsed = []
    # workspaces_json — сырой data[] (list[dict]) из 10X /workspaces
    ws_list: list[object] = cast("list[object]", parsed) if isinstance(parsed, list) else []
    uid = str(row["target_user_id"])
    member_only: list[dict[str, object]] = []
    for w in ws_list:
        if not isinstance(w, dict):
            continue
        wd: dict[str, object] = cast("dict[str, object]", w)
        if str(wd.get("ownerId")) != uid:
            member_only.append(
                {
                    "workspace_id": wd.get("id"),
                    "name": wd.get("name"),
                    "marketplace": wd.get("marketplace"),
                }
            )
    return {
        "email": row["email"],
        "target_user_id": uid,
        "target_name": row["target_name"],
        "is_email_verified": bool(row["is_email_verified"]),
        "reason": row["reason"],
        "fetched_at": row["fetched_at"],
        "owned": owned_rows,
        "member_only": member_only,
        "sessions": _sessions_for(conn, uid),
        "workspaces": ws_list,
    }


def _run_email_command(
    conn: sqlite3.Connection,
    value: str,
    *,
    reason: str | None,
    refresh_cache: bool,
    projection: str | None,
) -> None:
    """email-ветка `mpu search`: fetch-on-miss / `--refresh-cache` через 10X API,
    ensure-registry, вывод всего (или проекция по флагу). Единственный путь к
    impersonation (audited) — см. mpu/CLAUDE.md §7."""
    from mpu.lib import x10_resolve, x10api  # lazy: тянет httpx

    email = value.lower()
    store.bootstrap(conn)  # на старом кэше может не быть x10_* таблиц
    cached = _get_email_client_row(conn, email)
    if refresh_cache or cached is None:
        eff_reason = reason if reason is not None else f"ТП {date.today().isoformat()}"
        try:
            bundle = x10_resolve.fetch_email_bundle(conn, email, reason=eff_reason)
        except (x10_resolve.X10ResolveError, x10api.X10ApiError) as e:
            hint = ""
            if isinstance(e, x10api.X10ApiError) and e.status in (401, 403):
                hint = " (нужны 10X staff-креды X10_LOGIN/X10_PASSWORD, не sl-back TOKEN_*)"
            typer.echo(f"mpu search: {e}{hint}", err=True)
            raise typer.Exit(code=2) from None
        from mpu.commands import update as update_cmd

        for owned in bundle.owned:
            if not _by_client_id(conn, owned.workspace_id) and not update_cmd.fetch_single_client(
                owned.workspace_id
            ):
                typer.echo(
                    f"warning: client {owned.workspace_id} не найден в реестре "
                    "(показан без таблицы)",
                    err=True,
                )
        cached = _get_email_client_row(conn, email)

    if cached is None:
        typer.echo(f"mpu search: {email} не резолвится в client_id", err=True)
        raise typer.Exit(code=2)

    owned_rows = _owned_rows(conn, cached)
    if projection:
        for line in _project(owned_rows, projection):
            typer.echo(line)
        return
    typer.echo(
        json.dumps(_email_output_obj(conn, cached, owned_rows), ensure_ascii=False, indent=2)
    )


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
    reason: Annotated[
        str | None,
        typer.Option(
            "--reason",
            help=(
                "email-селектор: причина impersonation (логируется на проде 10X). "
                "Рекомендуется ссылка на Kaiten-карточку (для аудита). "
                "Default: 'ТП <YYYY-MM-DD>'."
            ),
        ),
    ] = None,
    refresh_cache: Annotated[
        bool,
        typer.Option(
            "--refresh-cache",
            help="email-селектор: перезапросить из 10X API и обновить кэш (иначе из кэша)",
        ),
    ] = False,
) -> None:
    """Поиск по локальному ~/.config/mpu/mpu.db.

    По умолчанию — JSON-array строк со всеми полями. На пустом результате
    автоматически вызывает `mpu update` и повторяет поиск (отключается через `--no-update`).

    email-селектор (`mpu search user@example.com`) резолвит email → client_id через
    10X (sw-back) admin API (impersonation, audited на проде) и кэширует всё в sqlite;
    повторные запросы — из кэша, `--refresh-cache` форсит. См. mpu/CLAUDE.md §7.
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

    is_email = looks_like_email(value)
    if (reason is not None or refresh_cache) and not is_email:
        typer.echo(
            "mpu search: --reason/--refresh-cache применимы только к email-селектору", err=True
        )
        raise typer.Exit(code=2)

    with store.store() as conn:
        if is_email:
            _run_email_command(
                conn,
                value,
                reason=reason,
                refresh_cache=refresh_cache,
                projection=chosen[0] if chosen else None,
            )
            return

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
