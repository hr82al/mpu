# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""`mpu sheet` — Google Spreadsheets через Apps Script webapp (нативный Python).

Subcommands:
    get [ranges...]       Read cell values from one or more A1 ranges
    ls                    List sheets in a spreadsheet
    resolve               Show which spreadsheet ID will be used and source
    set [range] [value]   Write a value (or batch via --from)
    open [sheet]          Open spreadsheet (or specific sheet) in browser
    alias add/ls/rm       Manage spreadsheet aliases
    sync                  Pull spreadsheets metadata from sl-back into local cache
    cache clear/info      Inspect or clear local whole-tab cache

Whole-tab кэш на 2 часа (configurable через `sheet.cache.tab_ttl`).
Любое чтение тянет весь tab разом — последующие чтения любых ranges отвечают
из SQLite моментально. Кэш авточистится по TTL и общему размеру.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
import webbrowser
from pathlib import Path
from typing import Annotated, Any

import typer

from mpu.lib import store
from mpu.lib.log import logger
from mpu.lib.sheet_api import SheetApiError, WebappClient
from mpu.lib.sheet_cache import (
    FetchResult,
    clear_all,
    enforce_size_cap,
    get_metadata,
    get_ranges,
    invalidate_tab,
    parse_range,
    sweep_expired,
)
from mpu.lib.sheet_resolver import (
    ID_RE,
    URL_RE,
    AmbiguousSpreadsheetError,
    ResolvedSpreadsheet,
    SpreadsheetResolveError,
    resolve,
)

_ALIAS_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

COMMAND_NAME = "mpu sheet"
COMMAND_SUMMARY = "Google Spreadsheets read/write (whole-tab кэш на 2 часа)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help="Google Spreadsheets через Apps Script webapp (native Python).",
)

alias_app = typer.Typer(no_args_is_help=True, help="Manage spreadsheet aliases.")
cache_app = typer.Typer(no_args_is_help=True, help="Inspect or clear local cache.")
app.add_typer(alias_app, name="alias")
app.add_typer(cache_app, name="cache")


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────


def _open_db() -> sqlite3.Connection:
    """Открыть БД и выполнить housekeeping (TTL sweep + size cap)."""
    conn = store.open_store()
    try:
        sweep_expired(conn)
        enforce_size_cap(conn)
    except sqlite3.OperationalError as e:
        logger.warning(f"sheet: sweep skipped (schema missing?): {e}")
    return conn




def _resolve_ss(conn: sqlite3.Connection, flag_value: str | None) -> ResolvedSpreadsheet:
    try:
        return resolve(flag_value, conn)
    except AmbiguousSpreadsheetError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(code=2) from e
    except SpreadsheetResolveError as e:
        typer.echo(f"mpu sheet: {e}", err=True)
        raise typer.Exit(code=2) from e


def _read_ranges_from_file(path: str) -> list[str]:
    """Прочитать ranges из файла (`-` для stdin), по одному на строку, `#` — комментарий."""
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    out: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(s)
    return out


def _prefix_bare_ranges(ranges: list[str], default_tab: str | None) -> list[str]:
    """Если `--sheet N` задан — для ranges без `!` префиксить N."""
    if not default_tab:
        return ranges
    out: list[str] = []
    for r in ranges:
        if "!" in r:
            out.append(r)
        else:
            tab_part = f"'{default_tab}'" if any(ch in default_tab for ch in " '!") else default_tab
            out.append(f"{tab_part}!{r}")
    return out


# ────────────────────────────────────────────────────────────────────────────
# get
# ────────────────────────────────────────────────────────────────────────────


@app.command()
def get(
    ranges: Annotated[
        list[str] | None,
        typer.Argument(help="A1-notation ranges (с префиксом 'Tab!' или без — см. --sheet)."),
    ] = None,
    spreadsheet: Annotated[
        str | None,
        typer.Option("-s", "--spreadsheet", help="Spreadsheet ID/URL/alias/client_id/title."),
    ] = None,
    sheet: Annotated[
        str | None,
        typer.Option("-n", "--sheet", help="Default tab name для ranges без префикса."),
    ] = None,
    from_file: Annotated[
        str | None,
        typer.Option("--from", help="Ranges из файла (`-` для stdin), один на строку."),
    ] = None,
    render: Annotated[
        str, typer.Option("--render", help="both | values | formulas | formatted")
    ] = "both",
    raw: Annotated[
        bool, typer.Option("--raw", help="Bare values; single cell без trailing newline.")
    ] = False,
    tsv: Annotated[
        bool, typer.Option("--tsv", help="TSV (TAB-separated, ranges по blank line).")
    ] = False,
    refresh: Annotated[
        bool,
        typer.Option("-R", "--refresh", help="Skip cache, fetch fresh, overwrite cache."),
    ] = False,
) -> None:
    """Read cell values from one or more A1-notation ranges."""
    if render not in ("both", "values", "formulas", "formatted"):
        typer.echo("--render must be one of: both, values, formulas, formatted", err=True)
        raise typer.Exit(code=2)

    all_ranges: list[str] = list(ranges or [])
    if from_file:
        all_ranges.extend(_read_ranges_from_file(from_file))
    if not all_ranges and sheet:
        # `--sheet Tab` без range → весь tab.
        all_ranges = [sheet]
        sheet = None

    if not all_ranges:
        typer.echo("Usage: mpu sheet get [RANGES...] [--from FILE] [--sheet TAB]", err=True)
        raise typer.Exit(code=2)

    all_ranges = _prefix_bare_ranges(all_ranges, sheet)

    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        refs = [parse_range(r, default_tab=sheet) for r in all_ranges]

        try:
            api = WebappClient.from_env()
            results = get_ranges(conn, api, resolved.ss_id, refs, render=render, refresh=refresh)
        except SheetApiError as e:
            typer.echo(f"mpu sheet: {e}", err=True)
            raise typer.Exit(code=1) from e

        if raw:
            _print_raw(results)
        elif tsv:
            _print_tsv(results)
        else:
            _print_json(resolved.ss_id, results)
    finally:
        conn.close()


def _print_json(ss_id: str, results: list[FetchResult]) -> None:
    value_ranges: list[dict[str, Any]] = []
    for r in results:
        item: dict[str, Any] = {"range": r.range}
        if r.values is not None:
            item["values"] = r.values
        if r.formulas is not None:
            item["formulas"] = r.formulas
        if r.formatted is not None:
            item["formatted"] = r.formatted
        item["fromCache"] = r.from_cache
        value_ranges.append(item)
    print(
        json.dumps(
            {"spreadsheetId": ss_id, "valueRanges": value_ranges},
            ensure_ascii=False,
            indent=2,
        )
    )


def _pick_layer(r: FetchResult) -> list[list[Any]] | None:
    if r.values is not None:
        return r.values
    if r.formulas is not None:
        return r.formulas
    return r.formatted


def _print_raw(results: list[FetchResult]) -> None:
    # Bare values; single cell без trailing newline.
    pieces: list[str] = []
    for r in results:
        layer = _pick_layer(r)
        if layer is None:
            continue
        for row in layer:
            pieces.append("\t".join(str(c) for c in row))
    if len(results) == 1 and len(pieces) == 1 and "\t" not in pieces[0]:
        sys.stdout.write(pieces[0])
    else:
        sys.stdout.write("\n".join(pieces) + "\n")


def _print_tsv(results: list[FetchResult]) -> None:
    out: list[str] = []
    for i, r in enumerate(results):
        if i > 0:
            out.append("")
        layer = _pick_layer(r)
        if layer is None:
            continue
        for row in layer:
            out.append("\t".join(str(c) for c in row))
    sys.stdout.write("\n".join(out) + "\n")


# ────────────────────────────────────────────────────────────────────────────
# ls
# ────────────────────────────────────────────────────────────────────────────


@app.command()
def ls(
    spreadsheet: Annotated[str | None, typer.Option("-s", "--spreadsheet")] = None,
    long_: Annotated[
        bool, typer.Option("-l", "--long", help="Title, rows×cols, sheetId, index.")
    ] = False,
    json_out: Annotated[
        bool, typer.Option("--json", help="Structured JSON array.")
    ] = False,
    refresh: Annotated[
        bool, typer.Option("-R", "--refresh", help="Skip metadata cache.")
    ] = False,
) -> None:
    """List sheet (tab) names in a Google Spreadsheet."""
    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        try:
            api = WebappClient.from_env()
            tabs = get_metadata(conn, api, resolved.ss_id, refresh=refresh)
        except SheetApiError as e:
            typer.echo(f"mpu sheet: {e}", err=True)
            raise typer.Exit(code=1) from e

        if json_out:
            print(json.dumps([t.__dict__ for t in tabs], ensure_ascii=False, indent=2))
            return

        if long_:
            for t in tabs:
                print(f"{t.title}\t{t.rows}×{t.cols}\tsheetId={t.sheet_id}\tindex={t.index}")
        else:
            for t in tabs:
                print(t.title)
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# resolve
# ────────────────────────────────────────────────────────────────────────────


@app.command(name="resolve")
def resolve_cmd(
    spreadsheet: Annotated[str | None, typer.Option("-s", "--spreadsheet")] = None,
) -> None:
    """Show which spreadsheet ID will be used and source (flag/env/config)."""
    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        print(
            json.dumps(
                {
                    "ss_id": resolved.ss_id,
                    "source": resolved.source,
                    "kind": resolved.kind,
                    "original_input": resolved.original_input,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# set
# ────────────────────────────────────────────────────────────────────────────


@app.command(name="set")
def set_(
    range_arg: Annotated[str | None, typer.Argument(metavar="RANGE")] = None,
    value: Annotated[str | None, typer.Argument(metavar="VALUE")] = None,
    spreadsheet: Annotated[str | None, typer.Option("-s", "--spreadsheet")] = None,
    from_file: Annotated[
        str | None,
        typer.Option(
            "--from",
            help="Batch из файла (`range<TAB>value` на строку, `#` — комментарий, `-` stdin).",
        ),
    ] = None,
    force: Annotated[
        bool,
        typer.Option("-f", "--force", help="Allow write (sheet.protected=true default)."),
    ] = False,
    literal: Annotated[
        bool, typer.Option("-l", "--literal", help="RAW value (не парсить формулы/числа).")
    ] = False,
) -> None:
    """Write values via spreadsheets/values/batchUpdate (default USER_ENTERED, --literal → RAW)."""
    conn = _open_db()
    try:
        protected_row = conn.execute(
            "SELECT value FROM config WHERE key = 'sheet.protected'"
        ).fetchone()
        protected = (protected_row["value"] if protected_row else "true").lower() != "false"
        if protected and not force:
            typer.echo(
                "mpu sheet set: write protected. Use --force/-f или "
                "`mpu sheet config sheet.protected false`.",
                err=True,
            )
            raise typer.Exit(code=2)

        data: list[dict[str, Any]] = []
        if from_file:
            if from_file == "-":
                text = sys.stdin.read()
            else:
                text = Path(from_file).read_text(encoding="utf-8")
            for line in text.splitlines():
                s = line.rstrip("\n")
                if not s.strip() or s.lstrip().startswith("#"):
                    continue
                if "\t" not in s:
                    typer.echo(f"mpu sheet set --from: missing TAB in line: {s!r}", err=True)
                    raise typer.Exit(code=2)
                r, v = s.split("\t", 1)
                data.append({"range": r.strip(), "values": [[v]]})
        else:
            if not range_arg or value is None:
                typer.echo(
                    "Usage: mpu sheet set RANGE VALUE  OR  "
                    "mpu sheet set --from FILE",
                    err=True,
                )
                raise typer.Exit(code=2)
            data.append({"range": range_arg, "values": [[value]]})

        resolved = _resolve_ss(conn, spreadsheet)
        try:
            api = WebappClient.from_env()
            resp = api.batch_update(
                resolved.ss_id, data, value_input_option="RAW" if literal else "USER_ENTERED"
            )
        except SheetApiError as e:
            typer.echo(f"mpu sheet set: {e}", err=True)
            raise typer.Exit(code=1) from e

        # Invalidate каждого затронутого tab'а.
        invalidated: set[str] = set()
        for d in data:
            try:
                ref = parse_range(d["range"])
                if ref.tab not in invalidated:
                    invalidate_tab(conn, resolved.ss_id, ref.tab)
                    invalidated.add(ref.tab)
            except ValueError:
                continue

        print(json.dumps(resp, ensure_ascii=False, indent=2))
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# open
# ────────────────────────────────────────────────────────────────────────────


@app.command(name="open")
def open_(
    sheet: Annotated[
        str | None, typer.Argument(help="Tab name (optional — открыть конкретный лист).")
    ] = None,
    spreadsheet: Annotated[str | None, typer.Option("-s", "--spreadsheet")] = None,
) -> None:
    """Open spreadsheet (or specific sheet) in browser."""
    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        url = f"https://docs.google.com/spreadsheets/d/{resolved.ss_id}/edit"
        if sheet:
            try:
                api = WebappClient.from_env()
                tabs = get_metadata(conn, api, resolved.ss_id)
                match = next((t for t in tabs if t.title == sheet), None)
                if match is None:
                    typer.echo(
                        f"mpu sheet open: tab '{sheet}' не найден. Available: "
                        f"{', '.join(t.title for t in tabs)}",
                        err=True,
                    )
                    raise typer.Exit(code=2)
                url = f"{url}#gid={match.sheet_id}"
            except SheetApiError as e:
                typer.echo(f"mpu sheet open: {e}", err=True)
                raise typer.Exit(code=1) from e
        webbrowser.open(url)
        print(url)
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# alias
# ────────────────────────────────────────────────────────────────────────────


@alias_app.command(name="add")
def alias_add(
    name: Annotated[str, typer.Argument(help="Имя alias'а — буквы/цифры/`_.-`.")],
    spreadsheet: Annotated[str, typer.Argument(help="Spreadsheet ID или URL.")],
) -> None:
    """Add or update an alias for a spreadsheet."""
    if not _ALIAS_NAME_RE.match(name):
        typer.echo(f"mpu sheet alias add: имя '{name}' содержит недопустимые символы.", err=True)
        raise typer.Exit(code=2)
    m = URL_RE.search(spreadsheet)
    ss_id = m.group(1) if m else spreadsheet
    if not ID_RE.match(ss_id):
        typer.echo(
            f"mpu sheet alias add: '{spreadsheet}' не похож на spreadsheet ID/URL.",
            err=True,
        )
        raise typer.Exit(code=2)
    conn = _open_db()
    try:
        conn.execute(
            "INSERT INTO sheet_aliases (name, ss_id, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET ss_id=excluded.ss_id",
            (name, ss_id, int(time.time())),
        )
        conn.commit()
        print(f"alias {name} → {ss_id}")
    finally:
        conn.close()


@alias_app.command(name="ls")
def alias_ls() -> None:
    """List all spreadsheet aliases."""
    conn = _open_db()
    try:
        try:
            rows = conn.execute(
                "SELECT name, ss_id FROM sheet_aliases ORDER BY name"
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        for r in rows:
            print(f"{r['name']}\t{r['ss_id']}")
    finally:
        conn.close()


@alias_app.command(name="rm")
def alias_rm(name: Annotated[str, typer.Argument()]) -> None:
    """Remove an alias."""
    conn = _open_db()
    try:
        cur = conn.execute("DELETE FROM sheet_aliases WHERE name = ?", (name,))
        conn.commit()
        if cur.rowcount:
            print(f"removed alias {name}")
        else:
            typer.echo(f"alias {name} not found", err=True)
            raise typer.Exit(code=1)
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# sync — pull spreadsheets list from sl-back
# ────────────────────────────────────────────────────────────────────────────


@app.command()
def sync() -> None:
    """Pull spreadsheets metadata from sl-back into local cache (sl_spreadsheets table)."""
    from mpu.lib.slapi import SlApi, SlApiError

    try:
        api = SlApi.from_env()
        rows = api.request("GET", "/admin/ss")
    except SlApiError as e:
        typer.echo(f"mpu sheet sync: {e}", err=True)
        raise typer.Exit(code=1) from e

    if not isinstance(rows, list):
        typer.echo(f"mpu sheet sync: ожидался list, получили {type(rows).__name__}", err=True)
        raise typer.Exit(code=1)

    now = int(time.time())
    conn = _open_db()
    try:
        # Транзакция: DELETE all + bulk INSERT — атомарная замена.
        with conn:
            conn.execute("DELETE FROM sl_spreadsheets")
            for r in rows:
                if not isinstance(r, dict):
                    continue
                ss_id = r.get("spreadsheet_id") or r.get("ss_id")
                client_id = r.get("client_id")
                if not ss_id or client_id is None:
                    continue
                conn.execute(
                    "INSERT INTO sl_spreadsheets "
                    "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        ss_id,
                        int(client_id),
                        r.get("title") or "",
                        r.get("template_name"),
                        1 if r.get("is_active", True) else 0,
                        r.get("server"),
                        now,
                    ),
                )
        print(f"synced {len(rows)} spreadsheets")
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# cache clear/info
# ────────────────────────────────────────────────────────────────────────────


@cache_app.command(name="clear")
def cache_clear(
    spreadsheet: Annotated[
        str | None,
        typer.Option("-s", "--spreadsheet", help="Только этот spreadsheet (иначе — весь)."),
    ] = None,
) -> None:
    """Clear local whole-tab cache."""
    conn = _open_db()
    try:
        if spreadsheet:
            resolved = _resolve_ss(conn, spreadsheet)
            cur = conn.execute("DELETE FROM sheet_tabs WHERE ss_id = ?", (resolved.ss_id,))
            conn.execute("DELETE FROM cache WHERE key = ?", (f"sheet:info:{resolved.ss_id}",))
            conn.commit()
            print(f"cleared {cur.rowcount or 0} tabs for {resolved.ss_id}")
        else:
            n = clear_all(conn)
            conn.execute("DELETE FROM cache WHERE key LIKE 'sheet:info:%'")
            conn.commit()
            print(f"cleared {n} tabs (whole cache)")
    finally:
        conn.close()


@cache_app.command(name="info")
def cache_info() -> None:
    """Show local whole-tab cache state — total size, per-spreadsheet breakdown."""
    conn = _open_db()
    try:
        try:
            total = conn.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM sheet_tabs"
            ).fetchone()
            rows = conn.execute(
                "SELECT ss_id, COUNT(*) AS n, SUM(size_bytes) AS bytes, MAX(fetched_at) AS latest "
                "FROM sheet_tabs GROUP BY ss_id ORDER BY bytes DESC"
            ).fetchall()
        except sqlite3.OperationalError:
            print("(no sheet_tabs table — run `mpu init`)")
            return
        print(f"total: {total['n']} tabs, {total['bytes'] / 1024:.1f} KB")
        for r in rows:
            print(
                f"  {r['ss_id']}  tabs={r['n']}  size={r['bytes'] / 1024:.1f}KB  "
                f"latest={r['latest']}"
            )
    finally:
        conn.close()
