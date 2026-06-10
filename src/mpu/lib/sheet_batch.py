"""Мини-язык пакетных операций Google Sheets → один atomic `batchUpdate` / `batchGet`.

Чистая логика (без сети): парсит декларативный скрипт и компилирует его в Google-shaped
`requests[]` (для `spreadsheets/batchUpdate`) либо в `ReadPlan` (для чтения). Команды
`mpu sheet batch-update` / `batch-get` оборачивают результат в webApp-`action`.

Принципы языка: кратко, интуитивно, самодокументируемо; очевидные defaults (лишнее не писать);
любые формы записи диапазона (буквы/номера/A1/R1C1/открытые) нормализуются к канонической форме
Sheets API (`GridRange` 0-based полуоткрытый / `DimensionRange`).

Один statement на строку (или через `;` вне кавычек/скобок); `#` — комментарий. Покрытие всех
~70 типов через generic-формы `@kind { json }` и `raw { json }`.

Документация и примеры — `mpu/docs/sheet-batch.md`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from mpu.lib.sheet_cache import RangeRef, col_letters_to_num, parse_range


class BatchScriptError(ValueError):
    """Ошибка разбора/компиляции скрипта мини-языка."""


# ────────────────────────────────────────────────────────────────────────────
# Разбиение на statements + токенизация (учёт кавычек, {json}, скобок, #-комментариев)
# ────────────────────────────────────────────────────────────────────────────

_OPEN = {"(": ")", "[": "]", "{": "}"}
_CLOSE = {")", "]", "}"}


def split_statements(text: str) -> list[str]:
    """Текст → список statements. Граница — `\\n` или `;` при глубине скобок 0 вне кавычек.

    `#` вне кавычек при глубине 0 — комментарий до конца строки. Многострочные `py{ … }` и
    `@kind { … }` (рост глубины по `{`) и формулы с `;` внутри `(…)` остаются цельными.
    """
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    quote: str | None = None
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if quote is not None:
            buf.append(c)
            if c == "\\" and i + 1 < n:
                buf.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            buf.append(c)
        elif c == "#" and depth == 0 and (not buf or buf[-1].isspace()):
            # `#` — комментарий только на границе токена (иначе это hex-цвет `bg=#EA4335`).
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif c in _OPEN:
            depth += 1
            buf.append(c)
        elif c in _CLOSE:
            depth = max(0, depth - 1)
            buf.append(c)
        elif (c == "\n" or c == ";") and depth == 0:
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(c)
        i += 1
    stmt = "".join(buf).strip()
    if stmt:
        out.append(stmt)
    return out


def tokenize(stmt: str) -> list[str]:
    """Statement → токены. Кавычки защищают пробелы (кавычки сохраняются в токене); `{ … }` —
    один токен (балансировка скобок). Используй `unquote()` где ожидается строковое значение."""
    toks: list[str] = []
    i = 0
    n = len(stmt)
    while i < n:
        while i < n and stmt[i].isspace():
            i += 1
        if i >= n:
            break
        if stmt[i] == "{":
            start = i
            depth = 0
            quote: str | None = None
            while i < n:
                c = stmt[i]
                if quote is not None:
                    if c == "\\":
                        i += 2
                        continue
                    if c == quote:
                        quote = None
                    i += 1
                    continue
                if c in ("'", '"'):
                    quote = c
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            toks.append(stmt[start:i])
            continue
        start = i
        quote = None
        while i < n and (quote is not None or not stmt[i].isspace()):
            c = stmt[i]
            if quote is not None:
                if c == "\\":
                    i += 2
                    continue
                if c == quote:
                    quote = None
                i += 1
                continue
            if c in ("'", '"'):
                quote = c
            i += 1
        toks.append(stmt[start:i])
    return toks


def unquote(s: str) -> str:
    """Снять обрамляющие кавычки и развернуть `\\`-escape; иначе вернуть как есть."""
    if len(s) >= 2 and s[0] in ("'", '"') and s[-1] == s[0]:
        return re.sub(r"\\(.)", r"\1", s[1:-1])
    return s


# ────────────────────────────────────────────────────────────────────────────
# Цвет / значения
# ────────────────────────────────────────────────────────────────────────────


def hex_to_rgb(s: str) -> dict[str, float]:
    """`#RRGGBB` / `#RGB` → `{red,green,blue}` (0..1). С `#AARRGGBB` берёт alpha."""
    h = s.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) not in (6, 8):
        raise BatchScriptError(f"плохой цвет: {s!r}")
    try:
        parts = [int(h[i : i + 2], 16) / 255 for i in range(0, len(h), 2)]
    except ValueError as e:
        raise BatchScriptError(f"плохой цвет: {s!r}") from e
    if len(parts) == 4:
        a, r, g, b = parts
        return {"red": r, "green": g, "blue": b, "alpha": a}
    r, g, b = parts
    return {"red": r, "green": g, "blue": b}


def coerce_value(raw: str, *, quoted: bool, literal: bool) -> dict[str, Any]:
    """Текст → Sheets `ExtendedValue`. `=…`→formula; число→number; true/false→bool; иначе string.

    `quoted` или `literal` → всегда string (не парсить формулу/число)."""
    if not literal and not quoted and raw.startswith("="):
        return {"formulaValue": raw}
    if quoted or literal:
        return {"stringValue": raw}
    low = raw.lower()
    if low in ("true", "false"):
        return {"boolValue": low == "true"}
    try:
        return {"numberValue": float(raw)}
    except ValueError:
        return {"stringValue": raw}


# ────────────────────────────────────────────────────────────────────────────
# Диапазоны: A1 / R1C1 / номера / буквы → канонические GridRange / DimensionRange
# ────────────────────────────────────────────────────────────────────────────

_R1C1_RE = re.compile(r"^[rR](\d+)[cC](\d+)$")


def _r1c1_to_a1(tok: str) -> str:
    m = _R1C1_RE.match(tok)
    if not m:
        return tok
    from mpu.lib.sheet_cache import col_num_to_letters

    return f"{col_num_to_letters(int(m.group(2)))}{int(m.group(1))}"


def parse_range_token(tok: str, default_tab: str | None) -> RangeRef:
    """Range-токен (A1/R1C1/открытый, с `'Tab'!` или без) → `RangeRef` (1-based)."""
    if "!" in tok:
        tab_part, span = tok.split("!", 1)
        return parse_range(f"{tab_part}!{_r1c1_to_a1(span)}", default_tab=default_tab)
    return parse_range(_r1c1_to_a1(tok), default_tab=default_tab)


def range_ref_to_gridrange(ref: RangeRef, sheet_id: int) -> dict[str, Any]:
    """`RangeRef` → `GridRange` (0-based, полуоткрытый); открытые границы опускаются."""
    gr: dict[str, Any] = {"sheetId": sheet_id}
    if ref.row1 is not None:
        gr["startRowIndex"] = ref.row1 - 1
    if ref.row2 is not None:
        gr["endRowIndex"] = ref.row2
    if ref.col1 is not None:
        gr["startColumnIndex"] = ref.col1 - 1
    if ref.col2 is not None:
        gr["endColumnIndex"] = ref.col2
    return gr


def _split_tab(tok: str, default_tab: str | None) -> tuple[str, str]:
    """`'Tab'!span` / `span` → (tab, span). Без `!` берёт default_tab."""
    if "!" in tok:
        tab_part, span = tok.split("!", 1)
        tab_part = tab_part.strip()
        if tab_part.startswith("'") and tab_part.endswith("'") and len(tab_part) >= 2:
            tab = tab_part[1:-1].replace("''", "'")
        else:
            tab = tab_part
        return tab, span.strip()
    if default_tab:
        return default_tab, tok.strip()
    raise BatchScriptError(f"нет имени листа в {tok!r} и не задан -n/--sheet")


def _dim_index(s: str, dimension: str) -> int:
    """Буква/номер → 0-based индекс. Для COLUMNS принимает и буквы, и цифры; для ROWS — цифры."""
    s = s.strip()
    if dimension == "COLUMNS" and s.isalpha():
        return col_letters_to_num(s) - 1
    if s.isdigit():
        return int(s) - 1
    raise BatchScriptError(f"плохой индекс {s!r} для {dimension}")


def to_dimension_range(
    tok: str, dimension: str, sheet_id_by_title: dict[str, int], default_tab: str | None
) -> dict[str, Any]:
    """`cols/rows` токен (`H`/`8`/`H:J`/`8:10`, опц. `'Tab'!`) → `DimensionRange` (0-based)."""
    tab, span = _split_tab(tok, default_tab)
    sid = _resolve_sid(tab, sheet_id_by_title)
    a, b = span.split(":", 1) if ":" in span else (span, span)
    start = _dim_index(a, dimension)
    end = _dim_index(b, dimension) + 1
    return {"sheetId": sid, "dimension": dimension, "startIndex": start, "endIndex": end}


def _resolve_sid(tab: str, sheet_id_by_title: dict[str, int]) -> int:
    if tab not in sheet_id_by_title:
        raise BatchScriptError(f"лист {tab!r} не найден в таблице")
    return sheet_id_by_title[tab]


# ────────────────────────────────────────────────────────────────────────────
# Стиль-флаги → CellFormat + fields-mask
# ────────────────────────────────────────────────────────────────────────────

_HALIGN = {"left": "LEFT", "center": "CENTER", "right": "RIGHT"}
_VALIGN = {"top": "TOP", "middle": "MIDDLE", "bottom": "BOTTOM"}


def parse_style_flags(tokens: list[str]) -> tuple[dict[str, Any], list[str]]:
    """Стиль-флаги (bold/bg=/fg=/fmt=) → (userEnteredFormat, fields). Неизв. флаг → ошибка."""
    fmt: dict[str, Any] = {}
    text_fmt: dict[str, Any] = {}
    fields: list[str] = []

    def add(path: str) -> None:
        if path not in fields:
            fields.append(path)

    for t in tokens:
        key, _, val = t.partition("=")
        val = unquote(val)
        if t in ("bold", "italic", "strike", "underline"):
            attr = "strikethrough" if t == "strike" else t
            text_fmt[attr] = True
            add(f"userEnteredFormat.textFormat.{attr}")
        elif t in _HALIGN:
            fmt["horizontalAlignment"] = _HALIGN[t]
            add("userEnteredFormat.horizontalAlignment")
        elif t in _VALIGN:
            fmt["verticalAlignment"] = _VALIGN[t]
            add("userEnteredFormat.verticalAlignment")
        elif t in ("wrap", "clip", "overflow"):
            fmt["wrapStrategy"] = {"wrap": "WRAP", "clip": "CLIP", "overflow": "OVERFLOW_CELL"}[t]
            add("userEnteredFormat.wrapStrategy")
        elif key == "bg":
            fmt["backgroundColor"] = hex_to_rgb(val)
            add("userEnteredFormat.backgroundColor")
        elif key == "fg":
            text_fmt["foregroundColor"] = hex_to_rgb(val)
            add("userEnteredFormat.textFormat.foregroundColor")
        elif key == "size":
            text_fmt["fontSize"] = int(val)
            add("userEnteredFormat.textFormat.fontSize")
        elif key == "font":
            text_fmt["fontFamily"] = val
            add("userEnteredFormat.textFormat.fontFamily")
        elif key == "fmt":
            ntype = (
                "PERCENT"
                if "%" in val
                else ("DATE" if re.search(r"[ymd]", val, re.I) else "NUMBER")
            )
            fmt["numberFormat"] = {"type": ntype, "pattern": val}
            add("userEnteredFormat.numberFormat")
        else:
            raise BatchScriptError(f"неизвестный стиль-флаг {t!r}")
    if text_fmt:
        fmt["textFormat"] = text_fmt
    return fmt, fields


# ────────────────────────────────────────────────────────────────────────────
# Range-aware sugar для generic @kind / raw: A1-строки → GridRange, #hex → rgb
# ────────────────────────────────────────────────────────────────────────────

_A1_PREFIX = "@"  # "@'Tab'!A1" внутри @kind json → подставить GridRange


def _sugar_json(obj: Any, sheet_id_by_title: dict[str, int], default_tab: str | None) -> Any:
    """Рекурсивно: `@'Tab'!A1`→GridRange; `sheetId` `@'Tab'`→id; `*Color` hex→rgb."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in cast("dict[Any, Any]", obj).items():
            ks = str(k)
            if ks == "sheetId" and isinstance(v, str) and v.startswith(_A1_PREFIX):
                out[ks] = _resolve_sid(_strip_at_tab(v), sheet_id_by_title)
            elif ks.endswith("Color") and isinstance(v, str) and v.startswith("#"):
                out[ks] = hex_to_rgb(v)
            else:
                out[ks] = _sugar_json(v, sheet_id_by_title, default_tab)
        return out
    if isinstance(obj, list):
        return [_sugar_json(v, sheet_id_by_title, default_tab) for v in cast("list[Any]", obj)]
    if isinstance(obj, str) and obj.startswith(_A1_PREFIX):
        ref = parse_range_token(obj[1:], default_tab)
        return range_ref_to_gridrange(ref, _resolve_sid(ref.tab, sheet_id_by_title))
    return obj


def _strip_at_tab(v: str) -> str:
    t = v[1:].strip()
    if t.startswith("'") and t.endswith("'"):
        t = t[1:-1].replace("''", "'")
    return t


# ────────────────────────────────────────────────────────────────────────────
# Update: парсинг + компиляция
# ────────────────────────────────────────────────────────────────────────────


@dataclass
class Stmt:
    """Один statement скрипта."""

    raw: str
    line: int


def parse_update_script(text: str) -> list[Stmt]:
    return [Stmt(raw=s, line=i + 1) for i, s in enumerate(split_statements(text))]


# Тип компилятора одного statement: (tokens, rest, ctx) -> requests[]
RunPy = Callable[[str], tuple[list[str], list[dict[str, Any]]]]


@dataclass
class _Ctx:
    sheet_id_by_title: dict[str, int]
    default_tab: str | None

    def sid(self, title: str) -> int:
        return _resolve_sid(title, self.sheet_id_by_title)

    def grid(self, tok: str) -> dict[str, Any]:
        ref = parse_range_token(tok, self.default_tab)
        return range_ref_to_gridrange(ref, self.sid(ref.tab))

    def dim(self, tok: str, dimension: str) -> dict[str, Any]:
        return to_dimension_range(tok, dimension, self.sheet_id_by_title, self.default_tab)


def compile_update(
    stmts: list[Stmt],
    sheet_id_by_title: dict[str, int],
    *,
    default_tab: str | None = None,
    allow_py: bool = False,
    run_py: RunPy | None = None,
    literal: bool = False,
) -> list[dict[str, Any]]:
    """Скрипт → `requests[]` для одного atomic `spreadsheets/batchUpdate`."""
    ctx = _Ctx(sheet_id_by_title, default_tab)
    requests: list[dict[str, Any]] = []
    for st in stmts:
        try:
            requests.extend(
                _compile_stmt(st.raw, ctx, allow_py=allow_py, run_py=run_py, literal=literal)
            )
        except BatchScriptError as e:
            raise BatchScriptError(f"строка {st.line}: {e}") from e
    return requests


def _compile_stmt(
    raw: str, ctx: _Ctx, *, allow_py: bool, run_py: RunPy | None, literal: bool
) -> list[dict[str, Any]]:
    s = raw.strip()
    if s.startswith("py{"):
        if not allow_py or run_py is None:
            raise BatchScriptError("py{…} требует флаг --allow-py")
        body = s[3:]
        body = body[: body.rfind("}")] if "}" in body else body
        emitted_stmts, emitted_reqs = run_py(body)
        out: list[dict[str, Any]] = list(emitted_reqs)
        for es in emitted_stmts:
            out.extend(_compile_stmt(es, ctx, allow_py=allow_py, run_py=run_py, literal=literal))
        return out
    if s.startswith("raw "):
        return [_parse_json_arg(s[4:])]
    if s.startswith("@"):
        kind, _, body = s[1:].partition(" ")
        obj = _parse_json_arg(body)
        return [{kind: _sugar_json(obj, ctx.sheet_id_by_title, ctx.default_tab)}]

    toks = tokenize(s)
    if not toks:
        return []
    verb = toks[0]
    # двухсловные глаголы (cols insert, sheet add, cond add, name add, group …)
    two = f"{verb} {toks[1]}" if len(toks) > 1 else None
    if two and two in _VERBS:
        return _VERBS[two](toks[2:], _rest_after(s, 2), ctx, literal)
    if verb in _VERBS:
        return _VERBS[verb](toks[1:], _rest_after(s, 1), ctx, literal)
    raise BatchScriptError(f"неизвестный глагол {verb!r}")


def _rest_after(stmt: str, n_words: int) -> str:
    """Подстрока после первых n_words токенов (quote-aware: имя листа с пробелами — один токен)."""
    i = 0
    n = len(stmt)
    count = 0
    while i < n and count < n_words:
        while i < n and stmt[i].isspace():
            i += 1
        quote: str | None = None
        while i < n and (quote is not None or not stmt[i].isspace()):
            c = stmt[i]
            if quote is not None:
                if c == "\\":
                    i += 2
                    continue
                if c == quote:
                    quote = None
                i += 1
                continue
            if c in ("'", '"'):
                quote = c
            i += 1
        count += 1
    return stmt[i:].lstrip()


def _parse_json_arg(s: str) -> dict[str, Any]:
    s = s.strip()
    try:
        obj = json.loads(s)
    except json.JSONDecodeError as e:
        raise BatchScriptError(f"плохой JSON: {e}") from e
    if not isinstance(obj, dict):
        raise BatchScriptError("ожидался JSON-объект")
    return obj  # type: ignore[return-value]


# ---- builders (каждый: (tokens_after_verb, rest, ctx, literal) -> requests[]) ----
Builder = Callable[[list[str], str, "_Ctx", bool], list[dict[str, Any]]]


def _b_set(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("set: нужен range")
    rng = toks[0]
    gr = ctx.grid(rng)
    # `set RANGE = VALUE…` — verbatim после `=`; иначе `set RANGE VALUE`.
    after = _rest_after(rest, 1)
    if after.startswith("="):
        value_raw = after[1:].strip()
        quoted = False
    elif len(toks) >= 2:
        value_raw = unquote(toks[1])
        quoted = toks[1] != value_raw
    else:
        raise BatchScriptError("set: нужно значение (`= …` или второй аргумент)")
    cell = {"userEnteredValue": coerce_value(value_raw, quoted=quoted, literal=literal)}
    return [
        {
            "updateCells": {
                "rows": [{"values": [cell]}],
                "fields": "userEnteredValue",
                "start": _start_of(gr),
            }
        }
    ]


def _start_of(gr: dict[str, Any]) -> dict[str, Any]:
    return {
        "sheetId": gr["sheetId"],
        "rowIndex": gr.get("startRowIndex", 0),
        "columnIndex": gr.get("startColumnIndex", 0),
    }


def _b_label(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("label: нужен range и текст")
    gr = ctx.grid(toks[0])
    text = unquote(toks[1])
    fmt, fields = parse_style_flags(toks[2:])
    cell: dict[str, Any] = {"userEnteredValue": {"stringValue": text}}
    mask = ["userEnteredValue"]
    if fmt:
        cell["userEnteredFormat"] = fmt
        mask.extend(fields)
    return [
        {
            "updateCells": {
                "rows": [{"values": [cell]}],
                "fields": ",".join(mask),
                "start": _start_of(gr),
            }
        }
    ]


def _b_note(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("note: нужен range и текст")
    gr = ctx.grid(toks[0])
    return [
        {
            "updateCells": {
                "rows": [{"values": [{"note": unquote(toks[1])}]}],
                "fields": "note",
                "start": _start_of(gr),
            }
        }
    ]


def _b_style(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("style: нужен range")
    gr = ctx.grid(toks[0])
    fmt, fields = parse_style_flags(toks[1:])
    if not fmt:
        raise BatchScriptError("style: нужны стиль-флаги")
    return [
        {
            "repeatCell": {
                "range": gr,
                "cell": {"userEnteredFormat": fmt},
                "fields": ",".join(fields),
            }
        }
    ]


def _b_clear(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("clear: нужен range")
    gr = ctx.grid(toks[0])
    what = toks[1] if len(toks) > 1 else "values"
    fields = {
        "values": "userEnteredValue",
        "formats": "userEnteredFormat",
        "all": "userEnteredValue,userEnteredFormat,note",
    }.get(what)
    if fields is None:
        raise BatchScriptError("clear: что — values|formats|all")
    return [{"updateCells": {"range": gr, "fields": fields}}]


def _b_cols_insert(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _insert_dim(toks, ctx, "COLUMNS")


def _b_rows_insert(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _insert_dim(toks, ctx, "ROWS")


def _insert_dim(toks: list[str], ctx: _Ctx, dimension: str) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("insert: нужен столбец/строка")
    dr = ctx.dim(toks[0], dimension)
    count = None
    inherit_after = False
    for t in toks[1:]:
        if t.startswith("+"):
            count = int(t[1:])
        elif t == "inherit=after":
            inherit_after = True
        elif t in ("inherit", "inherit=before"):
            inherit_after = False
    if count is not None:
        dr["endIndex"] = dr["startIndex"] + count
    return [{"insertDimension": {"range": dr, "inheritFromBefore": not inherit_after}}]


def _b_cols_delete(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"deleteDimension": {"range": ctx.dim(_one(toks, "delete"), "COLUMNS")}}]


def _b_rows_delete(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"deleteDimension": {"range": ctx.dim(_one(toks, "delete"), "ROWS")}}]


def _b_cols_move(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _move_dim(toks, ctx, "COLUMNS")


def _b_rows_move(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _move_dim(toks, ctx, "ROWS")


def _move_dim(toks: list[str], ctx: _Ctx, dimension: str) -> list[dict[str, Any]]:
    # `cols move B:D after H`
    if len(toks) < 3 or toks[1] != "after":
        raise BatchScriptError("move: `<src> after <dest>`")
    src = ctx.dim(toks[0], dimension)
    dest = _dim_index(_split_tab(toks[2], ctx.default_tab)[1], dimension) + 1
    return [{"moveDimension": {"source": src, "destinationIndex": dest}}]


def _b_cols_resize(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _resize_dim(toks, ctx, "COLUMNS")


def _b_rows_resize(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _resize_dim(toks, ctx, "ROWS")


def _resize_dim(toks: list[str], ctx: _Ctx, dimension: str) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("resize: нужен диапазон")
    dr = ctx.dim(toks[0], dimension)
    for t in toks[1:]:
        if t.startswith("px="):
            return [
                {
                    "updateDimensionProperties": {
                        "range": dr,
                        "properties": {"pixelSize": int(t[3:])},
                        "fields": "pixelSize",
                    }
                }
            ]
    raise BatchScriptError("resize: нужен px=N (или используй autosize)")


def _b_cols_autosize(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"autoResizeDimensions": {"dimensions": ctx.dim(_one(toks, "autosize"), "COLUMNS")}}]


def _b_rows_autosize(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"autoResizeDimensions": {"dimensions": ctx.dim(_one(toks, "autosize"), "ROWS")}}]


def _b_cols_hide(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _hide_dim(toks, ctx, "COLUMNS", True)


def _b_cols_show(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _hide_dim(toks, ctx, "COLUMNS", False)


def _b_rows_hide(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _hide_dim(toks, ctx, "ROWS", True)


def _b_rows_show(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _hide_dim(toks, ctx, "ROWS", False)


def _hide_dim(toks: list[str], ctx: _Ctx, dimension: str, hidden: bool) -> list[dict[str, Any]]:
    dr = ctx.dim(_one(toks, "hide/show"), dimension)
    return [
        {
            "updateDimensionProperties": {
                "range": dr,
                "properties": {"hiddenByUser": hidden},
                "fields": "hiddenByUser",
            }
        }
    ]


def _b_append(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    # `append cols N` / `append rows N` — на лист из -n/--sheet или из `on 'Tab'`.
    if len(toks) < 2:
        raise BatchScriptError("append: `cols|rows N [on 'Tab']`")
    dimension = {"cols": "COLUMNS", "rows": "ROWS"}.get(toks[0])
    if dimension is None:
        raise BatchScriptError("append: cols|rows")
    length = int(toks[1])
    tab = ctx.default_tab
    if len(toks) >= 4 and toks[2] == "on":
        tab = unquote(toks[3])
    if not tab:
        raise BatchScriptError("append: нужен лист (-n/--sheet или `on 'Tab'`)")
    return [
        {"appendDimension": {"sheetId": ctx.sid(tab), "dimension": dimension, "length": length}}
    ]


def _b_freeze(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    # Лист — первый токен; если первый токен это rows=/cols=, берём -n/--sheet.
    if toks and not toks[0].startswith(("rows=", "cols=")):
        tab = unquote(toks[0])
        flags = toks[1:]
    elif ctx.default_tab:
        tab = ctx.default_tab
        flags = toks
    else:
        raise BatchScriptError("freeze: нужен лист (или -n/--sheet)")
    grid: dict[str, Any] = {}
    fields: list[str] = []
    for t in flags:
        if t.startswith("rows="):
            grid["frozenRowCount"] = int(t[5:])
            fields.append("gridProperties.frozenRowCount")
        elif t.startswith("cols="):
            grid["frozenColumnCount"] = int(t[5:])
            fields.append("gridProperties.frozenColumnCount")
    if not fields:
        raise BatchScriptError("freeze: rows=N и/или cols=N")
    return [
        {
            "updateSheetProperties": {
                "properties": {"sheetId": ctx.sid(tab), "gridProperties": grid},
                "fields": ",".join(fields),
            }
        }
    ]


def _b_merge(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("merge: нужен range")
    gr = ctx.grid(toks[0])
    mtype = {"all": "MERGE_ALL", "rows": "MERGE_ROWS", "cols": "MERGE_COLUMNS"}.get(
        toks[1] if len(toks) > 1 else "all", "MERGE_ALL"
    )
    return [{"mergeCells": {"range": gr, "mergeType": mtype}}]


def _b_unmerge(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"unmergeCells": {"range": ctx.grid(_one(toks, "unmerge"))}}]


def _b_border(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("border: нужен range")
    gr = ctx.grid(toks[0])
    sides = "all"
    style = "SOLID"
    color = {"red": 0.0, "green": 0.0, "blue": 0.0}
    for t in toks[1:]:
        if t in ("all", "top", "bottom", "left", "right", "inner", "around"):
            sides = t
        elif t.startswith("style="):
            style = t[6:].upper()
        elif t.startswith("color="):
            color = hex_to_rgb(t[6:])
    border = {"style": style, "color": color}
    req: dict[str, Any] = {"range": gr}
    side_map = {
        "top": ["top"],
        "bottom": ["bottom"],
        "left": ["left"],
        "right": ["right"],
        "all": ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"],
        "around": ["top", "bottom", "left", "right"],
        "inner": ["innerHorizontal", "innerVertical"],
    }
    for key in side_map[sides]:
        req[key] = dict(border)
    return [{"updateBorders": req}]


def _b_find_replace(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("find-replace: нужны find и replacement")
    find_tok = toks[0]
    regex = False
    if len(find_tok) >= 2 and find_tok.startswith("/") and find_tok.endswith("/"):
        find = find_tok[1:-1]
        regex = True
    else:
        find = unquote(find_tok)
    fr: dict[str, Any] = {"find": find, "replacement": unquote(toks[1])}
    scoped = False
    for t in toks[2:]:
        if t == "regex":
            regex = True
        elif t == "case":
            fr["matchCase"] = True
        elif t == "formulas":
            fr["includeFormulas"] = True
        elif t == "allsheets":
            fr["allSheets"] = True
            scoped = True
        elif "!" in t:
            fr["range"] = ctx.grid(t)
            scoped = True
    fr["searchByRegex"] = regex
    if not scoped:
        if ctx.default_tab:
            fr["sheetId"] = ctx.sid(ctx.default_tab)
        else:
            fr["allSheets"] = True
    return [{"findReplace": fr}]


def _b_validate(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("validate: нужен range и условие")
    gr = ctx.grid(toks[0])
    cond, idx = _parse_condition(toks, 1)
    rule: dict[str, Any] = {"condition": cond}
    for t in toks[idx:]:
        if t == "strict":
            rule["strict"] = True
        elif t.startswith("msg="):
            rule["inputMessage"] = unquote(t[4:])
        elif t == "showdrop":
            rule["showCustomUi"] = True
    return [{"setDataValidation": {"range": gr, "rule": rule}}]


def _b_cond_add(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("cond add: нужен range")
    gr = ctx.grid(toks[0])
    cond, idx = _parse_condition(toks, 1)
    fmt, _fields = parse_style_flags(
        [t for t in toks[idx:] if "=" in t or t in ("bold", "italic", "strike")]
    )
    rule = {
        "ranges": [gr],
        "booleanRule": {
            "condition": cond,
            "format": fmt or {"backgroundColor": hex_to_rgb("#ffeb3b")},
        },
    }
    return [{"addConditionalFormatRule": {"rule": rule, "index": 0}}]


def _b_cond_clear(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("cond clear: нужен лист")
    sid = ctx.sid(unquote(toks[0]))
    index = 0
    for t in toks[1:]:
        if t.startswith("index="):
            index = int(t[6:])
    return [{"deleteConditionalFormatRule": {"sheetId": sid, "index": index}}]


_CMP = {
    ">=": "GREATER_THAN_EQ",
    ">": "GREATER",
    "<=": "LESS_THAN_EQ",
    "<": "LESS",
    "=": "EQ",
    "!=": "NOT_EQ",
}


def _parse_condition(toks: list[str], idx: int) -> tuple[dict[str, Any], int]:
    """Условие с позиции idx (num>=0 / one-of=a,b / custom=… / text-contains=… / blank)."""
    if idx >= len(toks):
        raise BatchScriptError("нет условия")
    t = toks[idx]
    key, _, val = t.partition("=")
    val = unquote(val)
    m = re.match(r"^num(>=|<=|!=|>|<|=)(.+)$", t)
    if m:
        return {
            "type": f"NUMBER_{_CMP[m.group(1)]}",
            "values": [{"userEnteredValue": m.group(2)}],
        }, idx + 1
    if key == "custom":
        return {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": val}]}, idx + 1
    if key == "one-of":
        return {
            "type": "ONE_OF_LIST",
            "values": [{"userEnteredValue": v} for v in val.split(",")],
        }, idx + 1
    if key == "text-contains":
        return {"type": "TEXT_CONTAINS", "values": [{"userEnteredValue": val}]}, idx + 1
    if key == "text-eq":
        return {"type": "TEXT_EQ", "values": [{"userEnteredValue": val}]}, idx + 1
    if t == "blank":
        return {"type": "BLANK"}, idx + 1
    if t == "not-blank":
        return {"type": "NOT_BLANK"}, idx + 1
    if t in ("checkbox", "bool"):
        return {"type": "BOOLEAN"}, idx + 1
    if t.startswith("="):
        return {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": t}]}, idx + 1
    raise BatchScriptError(f"непонятное условие {t!r}")


def _b_protect(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("protect: нужен range")
    pr: dict[str, Any] = {"range": ctx.grid(toks[0])}
    for t in toks[1:]:
        if t.startswith("editors="):
            pr["editors"] = {"users": t[8:].split(",")}
        elif t == "warn":
            pr["warningOnly"] = True
        elif t.startswith("desc="):
            pr["description"] = unquote(t[5:])
    return [{"addProtectedRange": {"protectedRange": pr}}]


def _b_unprotect(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    for t in toks:
        if t.startswith("id="):
            return [{"deleteProtectedRange": {"protectedRangeId": int(t[3:])}}]
    raise BatchScriptError("unprotect: нужен id=N")


def _b_sheet_add(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("sheet add: нужно имя")
    props: dict[str, Any] = {"title": unquote(toks[0])}
    grid: dict[str, Any] = {"rowCount": 1000, "columnCount": 26}
    for t in toks[1:]:
        if t.startswith("rows="):
            grid["rowCount"] = int(t[5:])
        elif t.startswith("cols="):
            grid["columnCount"] = int(t[5:])
        elif t.startswith("index="):
            props["index"] = int(t[6:])
    props["gridProperties"] = grid
    return [{"addSheet": {"properties": props}}]


def _b_sheet_delete(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"deleteSheet": {"sheetId": ctx.sid(unquote(_one(toks, "sheet delete")))}}]


def _b_sheet_dup(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("sheet dup: нужен лист")
    req: dict[str, Any] = {"sourceSheetId": ctx.sid(unquote(toks[0]))}
    if len(toks) >= 3 and toks[1] == "as":
        req["newSheetName"] = unquote(toks[2])
    return [{"duplicateSheet": req}]


def _b_sheet_rename(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("sheet rename: `<old> <new>`")
    return [
        {
            "updateSheetProperties": {
                "properties": {"sheetId": ctx.sid(unquote(toks[0])), "title": unquote(toks[1])},
                "fields": "title",
            }
        }
    ]


def _b_sheet_tab(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("sheet tab: `<лист> color=#..`")
    sid = ctx.sid(unquote(toks[0]))
    for t in toks[1:]:
        if t.startswith("color="):
            return [
                {
                    "updateSheetProperties": {
                        "properties": {"sheetId": sid, "tabColor": hex_to_rgb(t[6:])},
                        "fields": "tabColor",
                    }
                }
            ]
    raise BatchScriptError("sheet tab: нужен color=#..")


def _b_sort(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("sort: нужен range")
    gr = ctx.grid(toks[0])
    specs: list[dict[str, Any]] = []
    for t in toks[1:]:
        if t.startswith("by="):
            for part in t[3:].split(","):
                col, _, order = part.partition(":")
                specs.append(
                    {
                        "dimensionIndex": _dim_index(col, "COLUMNS"),
                        "sortOrder": "DESCENDING" if order == "desc" else "ASCENDING",
                    }
                )
    if not specs:
        raise BatchScriptError("sort: нужен by=COL[:desc][,…]")
    return [{"sortRange": {"range": gr, "sortSpecs": specs}}]


def _b_dedupe(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if not toks:
        raise BatchScriptError("dedupe: нужен range")
    req: dict[str, Any] = {"range": ctx.grid(toks[0])}
    for t in toks[1:]:
        if t.startswith("cols="):
            req["comparisonColumns"] = [
                {
                    "sheetId": req["range"]["sheetId"],
                    "dimension": "COLUMNS",
                    "startIndex": _dim_index(c, "COLUMNS"),
                    "endIndex": _dim_index(c, "COLUMNS") + 1,
                }
                for c in t[5:].split(",")
            ]
    return [{"deleteDuplicates": req}]


def _b_trim(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return [{"trimWhitespace": {"range": ctx.grid(_one(toks, "trim"))}}]


def _b_name_add(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    if len(toks) < 2:
        raise BatchScriptError("name add: `<имя> <range>`")
    return [
        {"addNamedRange": {"namedRange": {"name": unquote(toks[0]), "range": ctx.grid(toks[1])}}}
    ]


def _b_name_del(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    for t in toks:
        if t.startswith("id="):
            return [{"deleteNamedRange": {"namedRangeId": t[3:]}}]
    raise BatchScriptError("name del: нужен id=<namedRangeId>")


def _b_autofill(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    # `autofill <src> -> <dest>` — заполнить dest по серии (источник внутри dest-диапазона).
    if len(toks) < 3 or toks[1] != "->":
        raise BatchScriptError("autofill: `<src> -> <dest>`")
    return [{"autoFill": {"range": ctx.grid(toks[2]), "useAlternateSeries": False}}]


def _b_copy(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _paste(toks, ctx, "copyPaste")


def _b_cut(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _paste(toks, ctx, "cutPaste")


def _paste(toks: list[str], ctx: _Ctx, kind: str) -> list[dict[str, Any]]:
    if len(toks) < 3 or toks[1] != "->":
        raise BatchScriptError(f"{kind}: `<src> -> <dest>`")
    req: dict[str, Any] = {"source": ctx.grid(toks[0]), "destination": ctx.grid(toks[2])}
    if kind == "copyPaste":
        ptype = "PASTE_NORMAL"
        for t in toks[3:]:
            if t.startswith("type="):
                ptype = "PASTE_" + t[5:].upper()
        req["pasteType"] = ptype
    return [{kind: req}]


def _b_group(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _group(toks, ctx, "addDimensionGroup")


def _b_ungroup(toks: list[str], rest: str, ctx: _Ctx, literal: bool) -> list[dict[str, Any]]:
    return _group(toks, ctx, "deleteDimensionGroup")


def _group(toks: list[str], ctx: _Ctx, kind: str) -> list[dict[str, Any]]:
    if len(toks) < 2 or toks[0] not in ("cols", "rows"):
        raise BatchScriptError(f"{kind}: `cols|rows <range>`")
    dimension = "COLUMNS" if toks[0] == "cols" else "ROWS"
    return [{kind: {"range": ctx.dim(toks[1], dimension)}}]


def _one(toks: list[str], verb: str) -> str:
    if not toks:
        raise BatchScriptError(f"{verb}: нужен аргумент")
    return toks[0]


_VERBS: dict[str, Builder] = {
    "set": _b_set,
    "label": _b_label,
    "note": _b_note,
    "style": _b_style,
    "clear": _b_clear,
    "cols insert": _b_cols_insert,
    "rows insert": _b_rows_insert,
    "cols delete": _b_cols_delete,
    "rows delete": _b_rows_delete,
    "cols move": _b_cols_move,
    "rows move": _b_rows_move,
    "cols resize": _b_cols_resize,
    "rows resize": _b_rows_resize,
    "cols autosize": _b_cols_autosize,
    "rows autosize": _b_rows_autosize,
    "cols hide": _b_cols_hide,
    "cols show": _b_cols_show,
    "rows hide": _b_rows_hide,
    "rows show": _b_rows_show,
    "append": _b_append,
    "freeze": _b_freeze,
    "merge": _b_merge,
    "unmerge": _b_unmerge,
    "border": _b_border,
    "find-replace": _b_find_replace,
    "validate": _b_validate,
    "cond add": _b_cond_add,
    "cond clear": _b_cond_clear,
    "protect": _b_protect,
    "unprotect": _b_unprotect,
    "sheet add": _b_sheet_add,
    "sheet delete": _b_sheet_delete,
    "sheet dup": _b_sheet_dup,
    "sheet rename": _b_sheet_rename,
    "sheet tab": _b_sheet_tab,
    "sort": _b_sort,
    "dedupe": _b_dedupe,
    "trim": _b_trim,
    "name add": _b_name_add,
    "name del": _b_name_del,
    "autofill": _b_autofill,
    "copy": _b_copy,
    "cut": _b_cut,
    "group": _b_group,
    "ungroup": _b_ungroup,
}


def collect_sheet_ids(requests: list[dict[str, Any]]) -> set[int]:
    """Все `sheetId`, упомянутые в `requests[]` (для инвалидации кэша затронутых табов)."""
    found: set[int] = set()

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            for k, v in cast("dict[Any, Any]", o).items():
                if k == "sheetId" and isinstance(v, int):
                    found.add(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in cast("list[Any]", o):
                walk(v)

    walk(requests)
    return found


# ────────────────────────────────────────────────────────────────────────────
# Read: парсинг + компиляция (values + sheet-level)
# ────────────────────────────────────────────────────────────────────────────

# Аспекты sheet-level (spreadsheets/get, фильтр локально). Per-cell недоступны (нет gridData).
_SHEET_ASPECTS = {
    "merges",
    "cond",
    "protected",
    "charts",
    "banding",
    "filters",
    "named",
    "props",
    "meta",
    "dims",
}
_PERCELL_ASPECTS = {
    "formats",
    "userformat",
    "note",
    "validation",
    "hyperlink",
    "textruns",
    "everything",
    "value",
    "effective",
    "userentered",
    "formatted",
}
_RENDER = {
    "values": "FORMATTED_VALUE",
    "formatted": "FORMATTED_VALUE",
    "formula": "FORMULA",
    "unformatted": "UNFORMATTED_VALUE",
}


@dataclass
class ReadPlan:
    """План чтения: values (batchGet) и/или sheet-level meta (spreadsheets/get + фильтр)."""

    values: dict[str, Any] | None
    meta: dict[str, Any] | None


def compile_read(text: str, default_tab: str | None = None) -> ReadPlan:
    """Скрипт чтения → ReadPlan. Глаголы `get` (values) и `read` (sheet-level)."""
    values_ranges: list[str] = []
    major = "ROWS"
    render = "FORMATTED_VALUE"
    datetime_render = "SERIAL_NUMBER"
    aspects: list[str] = []
    sheets: list[str] = []
    for st in split_statements(text):
        toks = tokenize(st)
        verb = toks[0] if toks else ""
        if verb == "get":
            for t in toks[1:]:
                if t in _RENDER:
                    render = _RENDER[t]
                elif t == "rows":
                    major = "ROWS"
                elif t == "cols":
                    major = "COLUMNS"
                elif t == "serial":
                    datetime_render = "SERIAL_NUMBER"
                elif t == "datestr":
                    datetime_render = "FORMATTED_STRING"
                else:
                    values_ranges.append(_full_range(t, default_tab))
        elif verb == "read":
            for t in toks[1:]:
                if t in _SHEET_ASPECTS:
                    if t not in aspects:
                        aspects.append(t)
                elif t in _PERCELL_ASPECTS:
                    raise BatchScriptError(
                        f"аспект {t!r} (per-cell) недоступен: webApp не отдаёт gridData. "
                        "Доступны: " + ", ".join(sorted(_SHEET_ASPECTS))
                    )
                else:
                    sheets.append(unquote(t))
        else:
            raise BatchScriptError(f"read-глагол должен быть get|read, получено {verb!r}")
    values = None
    if values_ranges:
        values = {
            "ranges": values_ranges,
            "majorDimension": major,
            "valueRenderOption": render,
            "dateTimeRenderOption": datetime_render,
        }
    meta = None
    if aspects or sheets:
        meta = {"aspects": aspects, "sheets": sheets}
    if values is None and meta is None:
        raise BatchScriptError("пустой скрипт чтения")
    return ReadPlan(values=values, meta=meta)


def _full_range(tok: str, default_tab: str | None) -> str:
    """Range-токен для values batchGet: префиксует default_tab если нет `!`."""
    if "!" in tok:
        return tok
    if default_tab:
        # A1 требует кавычек для имён не из [A-Za-z0-9_] (пробел, дефис, и т.п.); `'`→`''`.
        simple = default_tab.replace("_", "").isalnum()
        tab = default_tab if simple else "'" + default_tab.replace("'", "''") + "'"
        return f"{tab}!{tok}"
    return tok


# Карта аспект → путь(и) в Spreadsheet resource (для локального фильтра ответа spreadsheets/get).
ASPECT_PATHS: dict[str, list[str]] = {
    "merges": ["merges"],
    "cond": ["conditionalFormats"],
    "protected": ["protectedRanges"],
    "charts": ["charts"],
    "banding": ["bandedRanges"],
    "filters": ["basicFilter", "filterViews"],
    "props": ["properties"],
    "meta": ["developerMetadata"],
    "dims": ["rowGroups", "columnGroups"],
}


def filter_meta(
    spreadsheet: dict[str, Any], aspects: list[str], sheets: list[str]
) -> dict[str, Any]:
    """Локальный фильтр ответа `spreadsheets/get` по запрошенным аспектам/листам."""
    out: dict[str, Any] = {}
    want_named = "named" in aspects
    if want_named:
        out["namedRanges"] = spreadsheet.get("namedRanges", [])
    sheet_aspects = [a for a in aspects if a != "named"]
    if not sheet_aspects:
        return out
    rows: list[dict[str, Any]] = []
    for sh in cast("list[dict[str, Any]]", spreadsheet.get("sheets", [])):
        props = cast("dict[str, Any]", sh.get("properties") or {})
        title = props.get("title", "")
        if sheets and title not in sheets:
            continue
        entry: dict[str, Any] = {"title": title}
        for a in sheet_aspects:
            for path in ASPECT_PATHS.get(a, []):
                if path in sh:
                    entry[path] = sh[path]
        rows.append(entry)
    out["sheets"] = rows
    return out
