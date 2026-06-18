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
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, cast

import typer

from mpu.lib import store
from mpu.lib.log import logger
from mpu.lib.sheet_api import SheetApiError, WebappClient
from mpu.lib.sheet_batch import (
    BatchScriptError,
    collect_sheet_ids,
    compile_read,
    compile_update,
    filter_meta,
    hex_to_rgb,
    parse_range_token,
    parse_update_script,
    range_ref_to_gridrange,
)
from mpu.lib.sheet_cache import (
    FetchResult,
    clear_all,
    col_num_to_letters,
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
    json_out: Annotated[bool, typer.Option("--json", help="Structured JSON array.")] = False,
    refresh: Annotated[bool, typer.Option("-R", "--refresh", help="Skip metadata cache.")] = False,
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

# Открытый одностолбцовый range: `[Tab!]Col<from>:Col` (конец — тот же столбец без строки).
_OPEN_COL_RE = re.compile(
    r"^(?P<prefix>(?:'[^']*'|[^'!]+)!)?(?P<col>[A-Za-z]+)(?P<from>\d+):(?P=col)$"
)


def _set_entries_from_json(text: str) -> list[tuple[str, str, str]]:
    """Парсинг stdin JSON `[{range, formula|value}]` → [(range, value, value_input_option)].

    `formula` → USER_ENTERED, `value` → RAW (имя свойства решает тип).
    """
    try:
        loaded: Any = json.loads(text)
    except json.JSONDecodeError as e:
        typer.echo(f"mpu sheet set: невалидный JSON stdin: {e}", err=True)
        raise typer.Exit(code=2) from e
    if not isinstance(loaded, list) or not loaded:
        typer.echo(
            "mpu sheet set: ожидался непустой JSON-массив [{range, formula|value}]", err=True
        )
        raise typer.Exit(code=2)
    out: list[tuple[str, str, str]] = []
    for i, item in enumerate(cast("list[Any]", loaded)):
        if not isinstance(item, dict):
            typer.echo(f"mpu sheet set: элемент #{i} не объект: {item!r}", err=True)
            raise typer.Exit(code=2)
        entry = cast("dict[str, Any]", item)
        rng = entry.get("range")
        if not isinstance(rng, str) or not rng:
            typer.echo(f"mpu sheet set: элемент #{i} без поля range", err=True)
            raise typer.Exit(code=2)
        if "formula" in entry:
            out.append((rng, str(entry["formula"]), "USER_ENTERED"))
        elif "value" in entry:
            out.append((rng, str(entry["value"]), "RAW"))
        else:
            typer.echo(f"mpu sheet set: элемент #{i} без formula/value", err=True)
            raise typer.Exit(code=2)
    return out


def _expand_fill(api: WebappClient, ss_id: str, rng: str, value: str) -> dict[str, Any]:
    """{range, values}: открытый столбец `Col<from>:Col` + скаляр → fill до последней строки
    с данными столбца; иначе — одна ячейка."""
    m = _OPEN_COL_RE.match(rng)
    if not m:
        return {"range": rng, "values": [[value]]}
    prefix, col, start = m.group("prefix") or "", m.group("col"), int(m.group("from"))
    resp = api.batch_get(ss_id, [f"{prefix}{col}:{col}"], value_render="UNFORMATTED_VALUE")
    vrs = cast("list[Any]", resp.get("valueRanges") or [])
    vals = cast("list[Any]", (vrs[0].get("values") if vrs else None) or [])
    last = len(vals)
    if last < start:
        return {"range": f"{prefix}{col}{start}", "values": [[value]]}
    return {"range": f"{prefix}{col}{start}:{col}{last}", "values": [[value]] * (last - start + 1)}


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
    literal: Annotated[
        bool, typer.Option("-l", "--literal", help="RAW value (не парсить формулы/числа).")
    ] = False,
) -> None:
    """Write values via spreadsheets/values/batchUpdate (default USER_ENTERED, --literal → RAW)."""
    conn = _open_db()
    try:
        try:
            api = WebappClient.from_env()
        except SheetApiError as e:
            typer.echo(f"mpu sheet set: {e}", err=True)
            raise typer.Exit(code=1) from e

        # groups[value_input_option] -> list of {range, values}
        default_opt = "RAW" if literal else "USER_ENTERED"
        groups: dict[str, list[dict[str, Any]]] = {"USER_ENTERED": [], "RAW": []}

        if from_file:
            resolved = _resolve_ss(conn, spreadsheet)
            text = sys.stdin.read() if from_file == "-" else Path(from_file).read_text("utf-8")
            for line in text.splitlines():
                s = line.rstrip("\n")
                if not s.strip() or s.lstrip().startswith("#"):
                    continue
                if "\t" not in s:
                    typer.echo(f"mpu sheet set --from: missing TAB in line: {s!r}", err=True)
                    raise typer.Exit(code=2)
                r, v = s.split("\t", 1)
                groups[default_opt].append({"range": r.strip(), "values": [[v]]})
        elif value is None and not sys.stdin.isatty():
            # JSON из stdin: [{range, formula|value}, ...]. Единственный позиционный (если есть)
            # трактуется как селектор таблицы; иначе -s/--spreadsheet / env. Ranges — из JSON.
            resolved = _resolve_ss(conn, spreadsheet or range_arg)
            for rng, val, opt in _set_entries_from_json(sys.stdin.read()):
                groups[opt].append(_expand_fill(api, resolved.ss_id, rng, val))
        elif range_arg is not None and value is not None:
            resolved = _resolve_ss(conn, spreadsheet)
            groups[default_opt].append({"range": range_arg, "values": [[value]]})
        else:
            typer.echo(
                "Usage: mpu sheet set RANGE VALUE | --from FILE | echo JSON | mpu sheet set [SSID]",
                err=True,
            )
            raise typer.Exit(code=2)

        try:
            responses = [
                api.batch_update(resolved.ss_id, d, value_input_option=opt)
                for opt, d in groups.items()
                if d
            ]
        except SheetApiError as e:
            typer.echo(f"mpu sheet set: {e}", err=True)
            raise typer.Exit(code=1) from e

        # Invalidate каждого затронутого tab'а.
        invalidated: set[str] = set()
        for data in groups.values():
            for d in data:
                try:
                    ref = parse_range(d["range"])
                    if ref.tab not in invalidated:
                        invalidate_tab(conn, resolved.ss_id, ref.tab)
                        invalidated.add(ref.tab)
                except ValueError:
                    continue

        out_resp = responses[0] if len(responses) == 1 else responses
        print(json.dumps(out_resp, ensure_ascii=False, indent=2))
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────────
# batch-update / batch-get — декларативный мини-язык (один atomic batchUpdate / batchGet)
# ────────────────────────────────────────────────────────────────────────────


def _gather_script(expr: list[str] | None, from_file: str | None) -> str:
    """Собрать скрипт мини-языка из `-e` (повторяемо), `--from FILE`/`-`(stdin) или pipe."""
    parts: list[str] = list(expr or [])
    if from_file:
        parts.append(sys.stdin.read() if from_file == "-" else Path(from_file).read_text("utf-8"))
    elif not parts and not sys.stdin.isatty():
        parts.append(sys.stdin.read())
    return "\n".join(parts)


def _make_run_py(
    api: WebappClient, ss_id: str, sid_by_title: dict[str, int], default_tab: str | None
) -> Callable[[str], tuple[list[str], list[dict[str, Any]]]]:
    """Фабрика compile-time исполнителя `py{ … }` (operator-trusted exec, как `mpu run-js`)."""

    def run_py(body: str) -> tuple[list[str], list[dict[str, Any]]]:
        emitted_stmts: list[str] = []
        emitted_reqs: list[dict[str, Any]] = []

        def gridrange(a1: str) -> dict[str, Any]:
            ref = parse_range_token(a1, default_tab)
            return range_ref_to_gridrange(ref, sid_by_title[ref.tab])

        def read(a1: str) -> list[list[Any]]:
            resp = api.batch_get(ss_id, [a1])
            vrs = cast("list[Any]", resp.get("valueRanges") or [])
            return cast("list[list[Any]]", (vrs[0].get("values") if vrs else None) or [])

        def emit(s: object) -> None:
            emitted_stmts.append(str(s))

        def request(d: dict[str, Any]) -> None:
            emitted_reqs.append(d)

        def col(i: int) -> str:
            return col_num_to_letters(int(i))

        def sheetid(t: str) -> int:
            return sid_by_title[t]

        env: dict[str, Any] = {
            "emit": emit,
            "request": request,
            "col": col,
            "rgb": hex_to_rgb,
            "sheetid": sheetid,
            "gridrange": gridrange,
            "read": read,
        }
        exec(body, env)  # operator-trusted, под флагом --allow-py
        return emitted_stmts, emitted_reqs

    return run_py


@app.command("batch-update")
def batch_update(
    expr: Annotated[
        list[str] | None,
        typer.Option(
            "-e",
            "--expr",
            help="Инструкции мини-языка (повторяемо; разделять ; или новой строкой).",
        ),
    ] = None,
    spreadsheet: Annotated[
        str | None,
        typer.Option("-s", "--spreadsheet", help="Spreadsheet ID/URL/alias/client_id/title."),
    ] = None,
    sheet: Annotated[
        str | None, typer.Option("-n", "--sheet", help="Лист по умолчанию (range без 'Tab!').")
    ] = None,
    from_file: Annotated[
        str | None, typer.Option("--from", help="Скрипт из файла (`-` — stdin).")
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Скомпилировать и напечатать requests[], НЕ отправлять."),
    ] = False,
    allow_py: Annotated[
        bool, typer.Option("--allow-py", help="Разрешить py{…} (exec Python для логики/генерации).")
    ] = False,
    literal: Annotated[
        bool,
        typer.Option(
            "-l", "--literal", help="Значения как строки (RAW, не парсить формулы/числа)."
        ),
    ] = False,
) -> None:
    r"""Пакетная ЗАПИСЬ в таблицу: простые инструкции → ОДИН запрос Google (batchUpdate).

    Пишешь по одной инструкции на строку (или через ;). Все они уходят вместе, одним запросом.
    Сначала проверь с --dry-run — покажет готовый requests[] и НЕ отправит.

    ОТКУДА БРАТЬ СКРИПТ
      -e "..."      инструкции прямо в команде (флаг можно повторять)
      --from FILE   из файла; FILE = -  → читать со stdin (pipe)
      -s ТАБЛИЦА    какая таблица: ID, ссылка, alias, client_id или часть названия
      -n ЛИСТ       лист по умолчанию для диапазонов без префикса 'Лист'!

    ДИАПАЗОН — пиши как удобно, приведётся к нужному виду
      H  или  8         столбец (буквой или номером — без разницы)
      H:J  или  8:10    несколько столбцов
      H5  или  r5c8     одна ячейка (A1 или R1C1)
      H2:J10            прямоугольник
      H:H               весь столбец;   H2:H — со 2-й строки вниз
      4:4  или  4       вся строка
      'Чек-лист'!H2:H   с явным листом (кавычки нужны для имён с дефисом/пробелом)

    ЗНАЧЕНИЯ (set)
      set A1 = =СУММ(B:B)   формула (после первого '=' идёт формула, тоже с '=')
      set A1 "привет"        текст
      set A1 42              число;   set A1 true — булево
      флаг -l/--literal → писать как есть, не превращать в формулу/число

    НАДПИСИ, СТИЛЬ, ФОРМАТ
      label H1 "Заголовок" bg=#EA4335 fg=#fff bold center
      style F5:F bg=#FCE8E6 fmt="0.00%"
      note H1 "комментарий"
      clear A2:A all            (all | values | formats)
      флаги стиля: bold italic strike underline · center left right · middle top bottom ·
                   wrap clip · bg=#.. fg=#.. size=N font=Arial fmt="0.00%"
      цвет: #EA4335, #fff, #AARRGGBB

    КОЛОНКИ И СТРОКИ (cols … / rows …)
      cols insert H +10 inherit=before      вставить 10 колонок начиная с H
      cols delete M:Q                        удалить
      cols move B:D after H                  переместить
      cols resize H:J px=120                 ширина (для строк — высота)
      cols autosize H:J                      авто-ширина
      cols hide M:Q   /   cols show M:Q      скрыть / показать
      append cols 5   /   append rows 100    дорастить лист
      freeze rows=4 cols=7                    закрепить шапку (лист берётся из -n)

    ОБЪЕДИНЕНИЕ И РАМКИ
      merge A1:C1               объединить (по умолч. всё; ещё: merge A1:C1 rows|cols)
      unmerge A1:C1
      border A1:C3 all          рамки (all|top|bottom|left|right|inner|around, style=, color=)

    ПРОВЕРКА ВВОДА И УСЛОВНЫЙ ФОРМАТ
      validate AJ18:AJ81 num>=0 strict msg="≥ 0"
      cond add F5:F custom='=AND(E5<>"";G5="")' bg=#EA4335
      cond clear 'Чек-лист' index=0
      условия: num>=0 num>0 num<=N num<N num=N num!=N · one-of=a,b,c ·
               text-contains=… text-eq=… · custom='=ФОРМУЛА' · blank not-blank checkbox

    ПОИСК И ЗАМЕНА
      find-replace старое новое              в текущем листе (из -n)
      find-replace /\bfoo\b/ bar             /.../ → по регулярке
      доп. слова: case · formulas · allsheets

    ЛИСТЫ
      sheet add "Новый" rows=1000 cols=26
      sheet delete 'Старый'        sheet rename 'Старый' "Новый"
      sheet dup 'Чек-лист' as "Копия"        sheet tab 'Чек-лист' color=#EA4335

    ПРОЧЕЕ
      name add my_rng 'Чек-лист'!A1:B2       name del id=123
      sort A2:F by=A,C:desc
      autofill A2:A3 -> A2:A100
      copy A1:B2 -> C1 type=FORMAT           (cut — вырезать)
      dedupe A2:F cols=A,B       trim A2:F
      group cols H:M             ungroup cols H:M
      protect 4:4 editors=a@b.com warn       unprotect id=123

    ЛЮБОЙ ДРУГОЙ ТИП (всего их ~70 у Google)
      @kind { json }   тело как в доках Google; @'Лист'!A1 → диапазон, #hex → цвет
        @deleteRange {"range": "@'Лист'!A1:B2", "shiftDimension": "ROWS"}
      raw { json }     дословно, без подстановок
        raw {"deleteSheet": {"sheetId": 12345}}

    PYTHON ДЛЯ ЛОГИКИ (флаг --allow-py)
      py{ ... } — выполняется при сборке. Доступно: emit("инструкция"), request({...}),
      col(i), rgb("#.."), gridrange("'Л'!A1"), sheetid("Л"), read("'Л'!A1")

    ПРИМЕРЫ ЦЕЛИКОМ
      mpu sheet batch-update -s 1AbC -n 'Чек-лист' -e "cols insert H +10 inherit=before"
      mpu sheet batch-update -s 1AbC -e "find-replace /\bold\b/ new formulas allsheets"
      mpu sheet batch-update -s 1AbC -n 'Чек-лист' -e "
        cols insert H +1
        label H1 'Новая' bg=#EA4335 bold
        set H2 = =A2*1.2"

    Подробно про мини-язык: mpu/docs/sheet-batch.md
    """
    script = _gather_script(expr, from_file)
    if not script.strip():
        typer.echo("mpu sheet batch-update: пустой скрипт (-e / --from / stdin)", err=True)
        raise typer.Exit(code=2)
    try:
        stmts = parse_update_script(script)
    except BatchScriptError as e:
        typer.echo(f"mpu sheet batch-update: {e}", err=True)
        raise typer.Exit(code=2) from e

    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        try:
            api = WebappClient.from_env()
            tabs = get_metadata(conn, api, resolved.ss_id, refresh=True)
            sid_by_title = {t.title: t.sheet_id for t in tabs}
            run_py = _make_run_py(api, resolved.ss_id, sid_by_title, sheet) if allow_py else None
            requests = compile_update(
                stmts,
                sid_by_title,
                default_tab=sheet,
                allow_py=allow_py,
                run_py=run_py,
                literal=literal,
            )
        except BatchScriptError as e:
            typer.echo(f"mpu sheet batch-update: {e}", err=True)
            raise typer.Exit(code=2) from e
        except SheetApiError as e:
            typer.echo(f"mpu sheet batch-update: {e}", err=True)
            raise typer.Exit(code=1) from e

        if not requests:
            typer.echo("нет операций")
            return
        if dry_run:
            print(json.dumps({"requests": requests}, ensure_ascii=False, indent=2))
            return
        try:
            resp = api.batch_update_spreadsheet(resolved.ss_id, requests)
        except SheetApiError as e:
            typer.echo(f"mpu sheet batch-update: {e}", err=True)
            raise typer.Exit(code=1) from e

        title_by_id = {sid: title for title, sid in sid_by_title.items()}
        for sid in collect_sheet_ids(requests):
            if sid in title_by_id:
                invalidate_tab(conn, resolved.ss_id, title_by_id[sid])
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    finally:
        conn.close()


@app.command("batch-get")
def batch_get_cmd(
    expr: Annotated[
        list[str] | None,
        typer.Option("-e", "--expr", help="Инструкции чтения (get/read; повторяемо)."),
    ] = None,
    spreadsheet: Annotated[str | None, typer.Option("-s", "--spreadsheet")] = None,
    sheet: Annotated[
        str | None, typer.Option("-n", "--sheet", help="Лист по умолчанию (range без 'Tab!').")
    ] = None,
    from_file: Annotated[
        str | None, typer.Option("--from", help="Скрипт из файла (`-` — stdin).")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Напечатать план чтения, НЕ запрашивать.")
    ] = False,
) -> None:
    r"""Пакетное ЧТЕНИЕ таблицы: значения + структура листа. Тот же язык диапазонов.

    Два глагола: get — значения ячеек; read — структура листа (объединения, правила, защиты…).
    Несколько инструкций — через ; или новой строкой. Ответ — JSON.

    GET — ЗНАЧЕНИЯ ЯЧЕЕК
      get 'Чек-лист'!A1:F             значения как на экране
      get A1:F formula                формулы (а не результат)
      get A1:F unformatted            «сырые» числа без форматирования
      get H2:H cols                   развернуть по столбцам (по умолчанию по строкам)
      get D2:D datestr                даты строкой (по умолч. число-serial)
      слова-модификаторы: values | formula | unformatted | formatted ·
                          rows | cols · serial | datestr
      (лист по умолчанию — из -n/--sheet; иначе пиши 'Лист'!A1)

    READ — СТРУКТУРА ЛИСТА
      read 'Чек-лист' merges cond protected     по одному листу
      read named                                имена диапазонов всей таблицы
      аспекты: merges · cond (условный формат) · protected (защиты) · charts · banding ·
               filters · named · props (свойства листа) · meta · dims

    ВАЖНО: оформление КОНКРЕТНЫХ ячеек (цвет/шрифт/заметка/проверка ввода) сейчас прочитать
    нельзя — webApp не отдаёт по-ячеечные данные. Эти слова дадут понятную ошибку.

    ПРИМЕРЫ ЦЕЛИКОМ
      mpu sheet batch-get -s 1AbC -e "get 'Чек-лист'!A1:F formula"
      mpu sheet batch-get -s 1AbC -n 'Чек-лист' -e "get H2:H unformatted cols"
      mpu sheet batch-get -s 1AbC -e "read 'Чек-лист' merges cond protected"
      mpu sheet batch-get -s 1AbC -e "read named"

    Подробно: mpu/docs/sheet-batch.md
    """
    script = _gather_script(expr, from_file)
    if not script.strip():
        typer.echo("mpu sheet batch-get: пустой скрипт (-e / --from / stdin)", err=True)
        raise typer.Exit(code=2)
    try:
        plan = compile_read(script, default_tab=sheet)
    except BatchScriptError as e:
        typer.echo(f"mpu sheet batch-get: {e}", err=True)
        raise typer.Exit(code=2) from e

    if dry_run:
        print(json.dumps({"values": plan.values, "meta": plan.meta}, ensure_ascii=False, indent=2))
        return

    conn = _open_db()
    try:
        resolved = _resolve_ss(conn, spreadsheet)
        out: dict[str, Any] = {"spreadsheetId": resolved.ss_id}
        try:
            api = WebappClient.from_env()
            if plan.values is not None:
                resp = api.call("spreadsheets/values/batchGet", ssId=resolved.ss_id, **plan.values)
                out["valueRanges"] = resp.get("valueRanges", [])
            if plan.meta is not None:
                full = api.call("spreadsheets/get", ssId=resolved.ss_id)
                out["meta"] = filter_meta(full, plan.meta["aspects"], plan.meta["sheets"])
        except SheetApiError as e:
            typer.echo(f"mpu sheet batch-get: {e}", err=True)
            raise typer.Exit(code=1) from e
        print(json.dumps(out, ensure_ascii=False, indent=2))
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
            rows = conn.execute("SELECT name, ss_id FROM sheet_aliases ORDER BY name").fetchall()
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
