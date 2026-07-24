"""`mpu xlsx` — чтение локальных Excel-файлов (нативный Python).

Subcommands:
    ls                    List sheets in an .xlsx file
    get [ranges...]       Read cell values from one or more A1 ranges
    open                  Open the file in the system default application
    resolve               Show which xlsx path will be used and where from
    alias add/ls/rm       Manage short names for long paths

Без сети и без кэша: каждый вызов читает файл с диска. Единственное
персистентное состояние — таблица алиасов в `~/.config/mpu/mpu.db`.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Annotated, Any

import typer

from mpu.lib import store
from mpu.lib.cli_err import fail
from mpu.lib.cli_opts import JsonOpt
from mpu.lib.sheet_cache import RangeRef, parse_range
from mpu.lib.xlsx_reader import Cell, SheetSummary, XlsxError, XlsxFile
from mpu.lib.xlsx_resolver import (
    SOURCE_LABELS,
    AliasError,
    Inspection,
    Resolved,
    XlsxResolveError,
    alias_add,
    alias_list,
    alias_remove,
    inspect_sources,
    resolve_path,
)

COMMAND_NAME = "mpu xlsx"
COMMAND_SUMMARY = "Чтение локальных .xlsx (без сети и кэша)"

_HELP = """Read local Excel (.xlsx) files.

Path resolution: --file/-f → env MPU_XLSX → config xlsx.default.
Aliases (xlsx alias add ...) work in any of those slots.
"""

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=_HELP,
)
alias_app = typer.Typer(
    no_args_is_help=True,
    help="Manage xlsx file aliases (short names → paths). "
    "Names must match [A-Za-z0-9_.-]+ (no spaces, shell-friendly).",
)
app.add_typer(alias_app, name="alias")

_RENDER_MODES = ("both", "values", "formulas")
_FILE_HELP = "Path to .xlsx (or alias); `~` is expanded."


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────


def _resolve(flag_value: str | None) -> Resolved:
    conn = store.open_store()
    try:
        return resolve_path(conn, flag_value)
    except XlsxResolveError as e:
        fail(
            COMMAND_NAME,
            str(e),
            code=2,
            hint="--file <путь>, export MPU_XLSX=<путь> или задай config xlsx.default",
        )
    finally:
        conn.close()


def _open_book(path: Path) -> XlsxFile:
    try:
        return XlsxFile.open(path)
    except XlsxError as e:
        fail(COMMAND_NAME, str(e), code=1)


def _read_ranges_from_file(path: str) -> list[str]:
    """Ranges из файла (`-` для stdin), по одному на строку, `#` — комментарий."""
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return [s for line in text.splitlines() if (s := line.strip()) and not s.startswith("#")]


def _prefix_bare_ranges(ranges: list[str], default_sheet: str | None) -> list[str]:
    """Если `--sheet N` задан — для ranges без `!` префиксить N."""
    if not default_sheet:
        return ranges
    quoted = f"'{default_sheet}'" if any(ch in default_sheet for ch in " '!") else default_sheet
    return [r if "!" in r else f"{quoted}!{r}" for r in ranges]


def _dedupe(ranges: list[str]) -> list[str]:
    """Убрать повторы, сохранив порядок первого вхождения."""
    seen: set[str] = set()
    out: list[str] = []
    for r in ranges:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _parse_refs(ranges: list[str], default_sheet: str | None) -> list[RangeRef]:
    try:
        return [parse_range(r, default_tab=default_sheet) for r in ranges]
    except ValueError as e:
        fail(COMMAND_NAME, str(e), code=2, hint='используй "Sheet!A1:B2" или передай --sheet <имя>')


# ────────────────────────────────────────────────────────────────────────────
# get
# ────────────────────────────────────────────────────────────────────────────


_GET_HELP = """Read cell values from one or more A1-notation ranges in a local .xlsx.

Path resolution: --file/-f → env MPU_XLSX → config xlsx.default.
Range sources can be combined: positional args, --sheet/-n + bare ranges,
--from <file|->. Open-ended ranges (A:A, 1:5) are clamped to the actual
sheet size; bare sheet name (or -n without ranges) fetches the whole sheet.

No network, no caching — every call reads the file from disk.

Examples:
  mpu xlsx get -f r.xlsx 'Sheet1!A1:B2'            # single range
  mpu xlsx get -f r.xlsx -n Лист A1:B5 C1:D2       # --sheet adds prefix to bare ranges
  mpu xlsx get -f r.xlsx 'S!A1' --raw              # bare value (single cell)
  mpu xlsx get -f r.xlsx 'S!A1:C3' --tsv           # TSV output
  mpu xlsx get -f r.xlsx 'S!A:C' --render values   # only values (skip formulas)
  mpu xlsx get -f r.xlsx --from ranges.txt         # one range per line, # comments
"""


@app.command(help=_GET_HELP)
def get(
    ranges: Annotated[
        list[str] | None,
        typer.Argument(help="A1-notation ranges, с префиксом 'Sheet!' или без (см. --sheet)."),
    ] = None,
    file: Annotated[str | None, typer.Option("-f", "--file", help=_FILE_HELP)] = None,
    sheet: Annotated[
        str | None,
        typer.Option("-n", "--sheet", help="Default sheet name для ranges без префикса."),
    ] = None,
    from_file: Annotated[
        str | None,
        typer.Option("--from", help="Ranges из файла (`-` для stdin), один на строку."),
    ] = None,
    render: Annotated[
        str, typer.Option("--render", help="both (значения + формулы) | values | formulas")
    ] = "both",
    json_out: JsonOpt = False,
    raw: Annotated[
        bool, typer.Option("--raw", help="Bare values; single cell без trailing newline.")
    ] = False,
    tsv: Annotated[bool, typer.Option("--tsv", help="TSV output (tab-separated).")] = False,
) -> None:
    if render not in _RENDER_MODES:
        fail(
            COMMAND_NAME,
            f'unknown --render value "{render}"',
            code=2,
            hint="both | values | formulas",
        )
    if sum((json_out, raw, tsv)) > 1:
        fail(COMMAND_NAME, "only one of --json / --raw / --tsv can be set", code=2)

    all_ranges = list(ranges or [])
    if from_file:
        all_ranges.extend(_read_ranges_from_file(from_file))
    if not all_ranges and sheet:
        # `--sheet Лист` без range → весь лист.
        all_ranges, sheet = [sheet], None
    if not all_ranges:
        fail(
            COMMAND_NAME,
            "no ranges provided",
            code=2,
            hint="mpu xlsx get [RANGES...] [--from FILE] [--sheet SHEET]",
        )

    refs = _parse_refs(_dedupe(_prefix_bare_ranges(all_ranges, sheet)), sheet)
    resolved = _resolve(file)
    book = _open_book(resolved.path)
    try:
        cells = book.read_ranges(refs)
    except XlsxError as e:
        fail(COMMAND_NAME, str(e), code=1)

    if raw:
        _print_raw(cells, render)
    elif tsv:
        _print_tsv(cells, render)
    else:
        _print_cells_json(resolved.path, cells, render)


def _columns_for(render: str) -> list[str]:
    if render == "values":
        return ["value"]
    if render == "formulas":
        return ["formula"]
    return ["value", "formula"]


def _print_cells_json(path: Path, cells: list[Cell], render: str) -> None:
    columns = _columns_for(render)
    items: list[dict[str, Any]] = []
    for cell in cells:
        item: dict[str, Any] = {"range": cell.range}
        if "value" in columns:
            item["value"] = cell.value
        # Ключ formula — только у реальных формул (CLAUDE.md §2).
        if "formula" in columns and cell.formula is not None:
            item["formula"] = cell.formula
        items.append(item)
    sys.stdout.write(json.dumps({"file": str(path), "cells": items}, ensure_ascii=False, indent=2))


def _cell_field(cell: Cell, column: str) -> str:
    value = cell.formula if column == "formula" else cell.value
    return "" if value is None else str(value)


def _escape_tsv(s: str) -> str:
    return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")


def _print_tsv(cells: list[Cell], render: str) -> None:
    columns = _columns_for(render)
    lines = ["\t".join(["range", *columns])]
    lines.extend(
        "\t".join([cell.range, *(_escape_tsv(_cell_field(cell, c)) for c in columns)])
        for cell in cells
    )
    sys.stdout.write("\n".join(lines) + "\n")


def _print_raw(cells: list[Cell], render: str) -> None:
    columns = _columns_for(render)
    if len(cells) == 1:
        # Одна ячейка → голое значение без trailing newline (удобно для $(...)).
        sys.stdout.write(_cell_field(cells[0], columns[0]))
        return
    lines = ["\t".join(_cell_field(cell, c) for c in columns) for cell in cells]
    sys.stdout.write("\n".join(lines) + "\n")


# ────────────────────────────────────────────────────────────────────────────
# ls
# ────────────────────────────────────────────────────────────────────────────


_LS_HELP = """List sheet (tab) names in a local .xlsx file.

Default output: one title per line (Unix-style, pipe-friendly).
Path resolution: --file/-f → env MPU_XLSX → config xlsx.default.

Examples:
  mpu xlsx ls -f /path/to/report.xlsx  # just the names
  mpu xlsx ls -f report.xlsx -l        # long: title, rows×cols, index
  mpu xlsx ls -f report.xlsx --json    # structured array
  mpu xlsx ls                          # use env MPU_XLSX or config xlsx.default
"""


@app.command(help=_LS_HELP)
def ls(
    file: Annotated[str | None, typer.Option("-f", "--file", help=_FILE_HELP)] = None,
    long_: Annotated[
        bool, typer.Option("-l", "--long", help="Detailed: title, rows×cols, index.")
    ] = False,
    json_out: JsonOpt = False,
) -> None:
    if long_ and json_out:
        fail(COMMAND_NAME, "only one of --long / --json can be set", code=2)

    sheets = _open_book(_resolve(file).path).list_sheets()
    if json_out:
        sys.stdout.write(
            json.dumps(
                [
                    {"title": s.title, "index": s.index, "rows": s.rows, "cols": s.cols}
                    for s in sheets
                ],
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if long_:
        sys.stdout.write(_format_ls_long(sheets))
        return
    sys.stdout.write("".join(f"{s.title}\n" for s in sheets))


def _format_ls_long(sheets: list[SheetSummary]) -> str:
    if not sheets:
        return ""
    # Ширина — по code points: кириллические имена не должны ломать колонки.
    width = max(len(s.title) for s in sheets)
    dims = [f"{s.rows}×{s.cols}" for s in sheets]
    dim_width = max(len(d) for d in dims)
    return "".join(
        f"{s.title.ljust(width)}  {dim.rjust(dim_width)}  #{s.index}\n"
        for s, dim in zip(sheets, dims, strict=True)
    )


# ────────────────────────────────────────────────────────────────────────────
# open / resolve
# ────────────────────────────────────────────────────────────────────────────


@app.command(name="open")
def open_(
    file: Annotated[str | None, typer.Option("-f", "--file", help=_FILE_HELP)] = None,
    print_: Annotated[
        bool, typer.Option("--print", help="Print resolved path instead of launching.")
    ] = False,
) -> None:
    """Open .xlsx file in the system default application (`--print` — только путь)."""
    resolved = _resolve(file)
    if print_:
        typer.echo(str(resolved.path))
        return
    opener = shutil.which("xdg-open") or shutil.which("open")
    if opener is None:
        fail(COMMAND_NAME, "не найден xdg-open/open", code=1, hint="mpu xlsx open --print")
    subprocess.Popen(
        [opener, str(resolved.path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


@app.command(name="resolve")
def resolve_cmd(
    file: Annotated[str | None, typer.Option("-f", "--file", help=_FILE_HELP)] = None,
    json_out: JsonOpt = False,
) -> None:
    """Diagnostic: prints the resolved path and every source that was checked."""
    conn = store.open_store()
    try:
        inspection = inspect_sources(conn, file)
    finally:
        conn.close()

    if json_out:
        _print_resolve_json(inspection)
        return
    if inspection.resolved is None:
        fail(
            COMMAND_NAME,
            "путь к .xlsx не задан ни в одном источнике",
            code=2,
            hint="--file <путь>, export MPU_XLSX=<путь> или задай config xlsx.default",
            extra=_format_sources(inspection),
        )
    typer.echo(_format_resolve_human(inspection.resolved, inspection))


def _print_resolve_json(inspection: Inspection) -> None:
    resolved = inspection.resolved
    payload: dict[str, Any] = {
        "resolved": None
        if resolved is None
        else {
            "path": str(resolved.path),
            "source": resolved.source,
            **({"alias": resolved.alias} if resolved.alias else {}),
        },
        "checked": [
            {"source": e.source, "label": e.label, "value": e.value, "used": e.used}
            for e in inspection.checked
        ],
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))


def _format_sources(inspection: Inspection) -> str:
    return "\n".join(
        f"{'*' if e.used else ' '} {e.label.ljust(24)}  {e.value or '(unset)'}"
        for e in inspection.checked
    )


def _format_resolve_human(resolved: Resolved, inspection: Inspection) -> str:
    alias_part = f", alias: {resolved.alias}" if resolved.alias else ""
    head = f"{resolved.path}  (source: {SOURCE_LABELS[resolved.source]}{alias_part})"
    return f"{head}\n\n{_format_sources(inspection)}"


# ────────────────────────────────────────────────────────────────────────────
# alias
# ────────────────────────────────────────────────────────────────────────────


@alias_app.command("add")
def alias_add_cmd(
    name: Annotated[str, typer.Argument(help="Alias name ([A-Za-z0-9_.-]+).")],
    path: Annotated[str, typer.Argument(help="Path to .xlsx file (`~` allowed).")],
) -> None:
    """Add or replace an alias."""
    conn = store.open_store()
    try:
        alias_add(conn, name, path)
    except AliasError as e:
        fail(f"{COMMAND_NAME} alias add", str(e), code=2)
    except sqlite3.OperationalError as e:
        fail(f"{COMMAND_NAME} alias add", str(e), code=1, hint="mpu init")
    finally:
        conn.close()
    typer.echo(f"alias {name} → {path}")


@alias_app.command("ls")
def alias_ls_cmd(
    json_out: JsonOpt = False,
) -> None:
    """List all aliases."""
    conn = store.open_store()
    try:
        aliases = alias_list(conn)
    finally:
        conn.close()

    if json_out:
        sys.stdout.write(
            json.dumps(
                [{"name": a.name, "path": a.path, "createdAt": a.created_at} for a in aliases],
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if not aliases:
        typer.echo("no aliases configured; add one with: mpu xlsx alias add <name> <path>")
        return
    width = max(len(a.name) for a in aliases)
    sys.stdout.write("".join(f"{a.name.ljust(width)}  {a.path}\n" for a in aliases))


@alias_app.command("rm")
def alias_rm_cmd(name: Annotated[str, typer.Argument(help="Alias name.")]) -> None:
    """Remove an alias."""
    conn = store.open_store()
    try:
        alias_remove(conn, name)
    finally:
        conn.close()
    typer.echo(f"removed {name}")
