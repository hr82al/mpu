# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Whole-tab кэш для `mpu sheet get`.

Алгоритм:
    1. Любой `sheet get 'Tab!A1:C3'` сначала смотрит в `sheet_tabs`.
    2. HIT (запись свежее TTL) → распаковать gzipped payload, вырезать span.
    3. MISS — fetch ВЕСЬ tab одним `batchGet` (для `--render both` — два, values
       + formulas), сохранить в `sheet_tabs`, вырезать span.
    4. Большие tabs (> `sheet.cache.max_tab_bytes`) — не кэшируем, прямой fetch
       запрошенного span. Пользователь это не замечает.

Sweep (lazy):
    - Перед каждой операцией: `DELETE FROM sheet_tabs WHERE fetched_at < cutoff`.
    - Если SUM(size_bytes) > cap — eviction оldest по `fetched_at`.

Invalidation:
    - `sheet set` после успешного batchUpdate → DELETE по затронутым (ss_id, tab).

Совместимость:
    - НЕ трогает `sheet_cells` (cell-level cache от new-mpu) — обе кэш-схемы
      сосуществуют, пока new-mpu не выведен из эксплуатации.
"""

from __future__ import annotations

import gzip
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from mpu.lib import env
from mpu.lib.log import logger
from mpu.lib.sheet_api import WebappClient

# Defaults — могут быть перекрыты через таблицу `config` или env.
DEFAULT_TAB_TTL_SECONDS = 7200  # 2h
DEFAULT_MAX_TAB_BYTES = 10 * 1024 * 1024  # 10 MB (после gzip)
DEFAULT_MAX_TOTAL_MB = 500
DEFAULT_METADATA_TTL_SECONDS = 7200  # 2h, тот же что у tab


# ────────────────────────────────────────────────────────────────────────────
# A1-нотация: парсинг ranges и tab-имён
# ────────────────────────────────────────────────────────────────────────────

_CELL_RE = re.compile(r"^([A-Za-z]+)?(\d+)?$")
# Strict cell-pattern (для эвристики «это span а не tab name»): max 3 letters.
_CELL_STRICT_RE = re.compile(r"^[A-Za-z]{1,3}\d*$|^\d+$")


@dataclass(frozen=True)
class RangeRef:
    tab: str
    row1: int | None  # None ⇒ open-ended (e.g. `A:A` без верхней границы по строкам)
    col1: int | None
    row2: int | None
    col2: int | None

    @property
    def is_whole_tab(self) -> bool:
        return all(v is None for v in (self.row1, self.col1, self.row2, self.col2))


def col_letters_to_num(s: str) -> int:
    n = 0
    for ch in s.upper():
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n


def col_num_to_letters(n: int) -> str:
    if n < 1:
        raise ValueError(f"Column number must be >= 1, got {n}")
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(ord("A") + r) + s
    return s


def _parse_cell(s: str) -> tuple[int | None, int | None]:
    """Cell ref → (row, col). Each может быть None для open-ended (`A` или `1`)."""
    m = _CELL_RE.match(s.strip())
    if not m or not s.strip():
        raise ValueError(f"Invalid A1 cell reference: '{s}'")
    col_str, row_str = m.group(1), m.group(2)
    col = col_letters_to_num(col_str) if col_str else None
    row = int(row_str) if row_str else None
    if col is None and row is None:
        raise ValueError(f"Invalid A1 cell reference: '{s}'")
    return row, col


def parse_range(range_str: str, *, default_tab: str | None = None) -> RangeRef:
    """Парсит range в формате `[Tab!]A1[:C3]`. `Tab` или `'Tab name'!`."""
    s = range_str.strip()
    if not s:
        raise ValueError("Empty range string")

    tab: str | None = None
    span: str

    if "!" in s:
        tab_part, span = s.split("!", 1)
        tab_part = tab_part.strip()
        if tab_part.startswith("'") and tab_part.endswith("'") and len(tab_part) >= 2:
            tab = tab_part[1:-1].replace("''", "'")
        else:
            tab = tab_part
    elif default_tab:
        # `--sheet TAB` задан → input — это span (без префикса).
        tab = default_tab
        span = s
    elif ":" in s or _CELL_STRICT_RE.match(s):
        # Похоже на span (A1, A1:B2, 1:5), но tab не задан → ошибка.
        raise ValueError(
            f"Range '{range_str}' has no tab name and no default tab provided"
        )
    else:
        # Без `!`, без default_tab, не похоже на span → весь input это tab name.
        tab = s
        span = ""

    if not tab:
        raise ValueError(f"Range '{range_str}' has no tab name and no default tab provided")

    if not span:
        return RangeRef(tab=tab, row1=None, col1=None, row2=None, col2=None)

    if ":" in span:
        left, right = span.split(":", 1)
    else:
        left = right = span
    r1, c1 = _parse_cell(left)
    r2, c2 = _parse_cell(right)
    return RangeRef(tab=tab, row1=r1, col1=c1, row2=r2, col2=c2)


# ────────────────────────────────────────────────────────────────────────────
# Config helpers — чтение из таблицы `config` с env override и default
# ────────────────────────────────────────────────────────────────────────────


def _config_int(conn: sqlite3.Connection, key: str, default: int) -> int:
    env_var = "MPU_" + key.replace(".", "_").upper()
    env_val = env.get(env_var)
    if env_val is not None:
        try:
            return int(env_val)
        except ValueError:
            logger.warning(f"sheet_cache: env {env_var}='{env_val}' is not int, using default")
    try:
        row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    except sqlite3.OperationalError:
        return default
    if row is None:
        return default
    try:
        return int(row["value"])
    except (ValueError, TypeError):
        return default


def get_tab_ttl(conn: sqlite3.Connection) -> int:
    return _config_int(conn, "sheet.cache.tab_ttl", DEFAULT_TAB_TTL_SECONDS)


def get_max_tab_bytes(conn: sqlite3.Connection) -> int:
    return _config_int(conn, "sheet.cache.max_tab_bytes", DEFAULT_MAX_TAB_BYTES)


def get_max_total_mb(conn: sqlite3.Connection) -> int:
    return _config_int(conn, "sheet.cache.max_total_mb", DEFAULT_MAX_TOTAL_MB)


# ────────────────────────────────────────────────────────────────────────────
# SQLite operations on sheet_tabs / cache
# ────────────────────────────────────────────────────────────────────────────


def sweep_expired(conn: sqlite3.Connection, *, now: int | None = None) -> int:
    """`DELETE FROM sheet_tabs WHERE fetched_at < cutoff`. Возвращает count удалённых."""
    cutoff = (now if now is not None else int(time.time())) - get_tab_ttl(conn)
    try:
        cur = conn.execute("DELETE FROM sheet_tabs WHERE fetched_at < ?", (cutoff,))
    except sqlite3.OperationalError:
        return 0
    conn.commit()
    return cur.rowcount or 0


def enforce_size_cap(conn: sqlite3.Connection) -> int:
    """Если общий размер кэша > cap — DELETE oldest до выхода ниже. Returns count."""
    cap_bytes = get_max_total_mb(conn) * 1024 * 1024
    try:
        total = conn.execute(
            "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM sheet_tabs"
        ).fetchone()["total"]
    except sqlite3.OperationalError:
        return 0
    if total <= cap_bytes:
        return 0
    # Удаляем oldest пока не уйдём ниже cap.
    deleted = 0
    rows = conn.execute(
        "SELECT ss_id, tab_name, size_bytes FROM sheet_tabs ORDER BY fetched_at ASC"
    ).fetchall()
    for r in rows:
        if total <= cap_bytes:
            break
        conn.execute(
            "DELETE FROM sheet_tabs WHERE ss_id = ? AND tab_name = ?",
            (r["ss_id"], r["tab_name"]),
        )
        total -= r["size_bytes"]
        deleted += 1
    conn.commit()
    if deleted:
        logger.info(f"sheet_cache: evicted {deleted} tabs to fit cap {cap_bytes} bytes")
    return deleted


def invalidate_tab(conn: sqlite3.Connection, ss_id: str, tab_name: str) -> None:
    try:
        conn.execute(
            "DELETE FROM sheet_tabs WHERE ss_id = ? AND tab_name = ?", (ss_id, tab_name)
        )
        conn.execute("DELETE FROM cache WHERE key = ?", (f"sheet:info:{ss_id}",))
    except sqlite3.OperationalError:
        return
    conn.commit()


def clear_all(conn: sqlite3.Connection) -> int:
    """Полная очистка whole-tab кэша (для `sheet cache clear`)."""
    try:
        cur = conn.execute("DELETE FROM sheet_tabs")
    except sqlite3.OperationalError:
        return 0
    conn.commit()
    return cur.rowcount or 0


# ────────────────────────────────────────────────────────────────────────────
# Cache lookup + fetch
# ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TabPayload:
    """Содержимое одного tab'а в кэше."""

    values: list[list[Any]]  # UNFORMATTED_VALUE
    formulas: list[list[Any]]  # FORMULA
    dims: tuple[int, int]  # (rows, cols)


def _pack(payload: TabPayload) -> bytes:
    obj = {
        "values": payload.values,
        "formulas": payload.formulas,
        "dims": {"rows": payload.dims[0], "cols": payload.dims[1]},
    }
    return gzip.compress(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def _unpack(blob: bytes) -> TabPayload:
    obj = json.loads(gzip.decompress(blob).decode("utf-8"))
    return TabPayload(
        values=obj.get("values") or [],
        formulas=obj.get("formulas") or [],
        dims=(obj["dims"]["rows"], obj["dims"]["cols"]),
    )


def _load_tab(
    conn: sqlite3.Connection, ss_id: str, tab_name: str
) -> tuple[TabPayload, int] | None:
    """Возвращает (payload, fetched_at) если запись свежее TTL, иначе None."""
    try:
        row = conn.execute(
            "SELECT payload, fetched_at FROM sheet_tabs WHERE ss_id = ? AND tab_name = ?",
            (ss_id, tab_name),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if row is None:
        return None
    ttl = get_tab_ttl(conn)
    if int(time.time()) - row["fetched_at"] > ttl:
        return None
    return _unpack(row["payload"]), row["fetched_at"]


def _save_tab(
    conn: sqlite3.Connection,
    ss_id: str,
    tab_name: str,
    payload: TabPayload,
    *,
    now: int | None = None,
) -> None:
    blob = _pack(payload)
    ts = now if now is not None else int(time.time())
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(ss_id, tab_name) DO UPDATE SET "
        "payload=excluded.payload, size_bytes=excluded.size_bytes, fetched_at=excluded.fetched_at",
        (ss_id, tab_name, blob, len(blob), ts),
    )
    conn.commit()


# ────────────────────────────────────────────────────────────────────────────
# Metadata (sheets list, dims per tab) — кэшируется в generic `cache` table
# ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TabInfo:
    title: str
    sheet_id: int
    rows: int
    cols: int
    index: int


def get_metadata(
    conn: sqlite3.Connection, api: WebappClient, ss_id: str, *, refresh: bool = False
) -> list[TabInfo]:
    """Список tabs spreadsheet'а. Кэш в таблице `cache` ключом `sheet:info:{ss_id}`."""
    key = f"sheet:info:{ss_id}"
    now = int(time.time())
    if not refresh:
        try:
            row = conn.execute(
                "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is not None and row["expires_at"] > now:
            data = json.loads(row["value"])
            return [TabInfo(**t) for t in data]

    resp = api.get_metadata(ss_id)
    tabs: list[TabInfo] = []
    for sheet in resp.get("sheets") or []:
        props = sheet.get("properties") or {}
        grid = props.get("gridProperties") or {}
        tabs.append(
            TabInfo(
                title=props.get("title", ""),
                sheet_id=int(props.get("sheetId", 0)),
                rows=int(grid.get("rowCount", 0)),
                cols=int(grid.get("columnCount", 0)),
                index=int(props.get("index", 0)),
            )
        )
    serialized = json.dumps([t.__dict__ for t in tabs], ensure_ascii=False)
    expires_at = now + DEFAULT_METADATA_TTL_SECONDS
    try:
        conn.execute(
            "INSERT INTO cache (key, value, created_at, expires_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value=excluded.value, created_at=excluded.created_at, expires_at=excluded.expires_at",
            (key, serialized, now, expires_at),
        )
        conn.commit()
    except sqlite3.OperationalError:
        # `cache` table missing — игнорируем, продолжим без кэша metadata.
        pass
    return tabs


def _tab_info(tabs: list[TabInfo], name: str) -> TabInfo | None:
    for t in tabs:
        if t.title == name:
            return t
    return None


# ────────────────────────────────────────────────────────────────────────────
# Slicing — вырезать запрошенный span из cached values/formulas
# ────────────────────────────────────────────────────────────────────────────


def slice_layer(
    layer: list[list[Any]], ref: RangeRef, dims: tuple[int, int]
) -> list[list[Any]]:
    """Вырезать прямоугольник [r1..r2] × [c1..c2] из layer, паддить '' до прямоугольника."""
    rows_total, cols_total = dims
    r1 = max(1, ref.row1) if ref.row1 is not None else 1
    r2 = min(rows_total, ref.row2) if ref.row2 is not None else rows_total
    c1 = max(1, ref.col1) if ref.col1 is not None else 1
    c2 = min(cols_total, ref.col2) if ref.col2 is not None else cols_total
    if r2 < r1 or c2 < c1:
        return []
    width = c2 - c1 + 1
    out: list[list[Any]] = []
    for ridx in range(r1 - 1, r2):
        src = layer[ridx] if ridx < len(layer) else []
        slc = list(src[c1 - 1 : c2])
        if len(slc) < width:
            slc.extend([""] * (width - len(slc)))
        out.append(slc)
    return out


def format_range_a1(tab: str, ref: RangeRef, dims: tuple[int, int]) -> str:
    rows_total, cols_total = dims
    r1 = ref.row1 if ref.row1 is not None else 1
    r2 = ref.row2 if ref.row2 is not None else rows_total
    c1 = ref.col1 if ref.col1 is not None else 1
    c2 = ref.col2 if ref.col2 is not None else cols_total
    tab_part = f"'{tab}'" if any(ch in tab for ch in " '!") else tab
    return f"{tab_part}!{col_num_to_letters(c1)}{r1}:{col_num_to_letters(c2)}{r2}"


# ────────────────────────────────────────────────────────────────────────────
# Whole-tab fetch
# ────────────────────────────────────────────────────────────────────────────


def _whole_tab_range(tab: str, info: TabInfo) -> str:
    end_col = col_num_to_letters(info.cols)
    tab_part = f"'{tab}'" if any(ch in tab for ch in " '!") else tab
    return f"{tab_part}!A1:{end_col}{info.rows}"


def _pad_layer(layer: list[list[Any]], rows: int, cols: int) -> list[list[Any]]:
    """Паддить layer до полного прямоугольника rows×cols значениями ''."""
    out: list[list[Any]] = []
    for r in range(rows):
        src = layer[r] if r < len(layer) else []
        row = (
            list(src) + [""] * (cols - len(src))
            if len(src) < cols
            else list(src[:cols])
        )
        out.append(row)
    return out


def fetch_whole_tab(api: WebappClient, ss_id: str, info: TabInfo) -> TabPayload:
    """Fetch values + formulas всего tab'а двумя batchGet вызовами."""
    range_str = _whole_tab_range(info.title, info)
    values_resp = api.batch_get(ss_id, [range_str], value_render="UNFORMATTED_VALUE")
    formulas_resp = api.batch_get(ss_id, [range_str], value_render="FORMULA")
    values_raw = (values_resp.get("valueRanges") or [{}])[0].get("values") or []
    formulas_raw = (formulas_resp.get("valueRanges") or [{}])[0].get("values") or []
    return TabPayload(
        values=_pad_layer(values_raw, info.rows, info.cols),
        formulas=_pad_layer(formulas_raw, info.rows, info.cols),
        dims=(info.rows, info.cols),
    )


# ────────────────────────────────────────────────────────────────────────────
# Главный entry point
# ────────────────────────────────────────────────────────────────────────────


RenderMode = str  # "both" | "values" | "formulas" | "formatted"


@dataclass(frozen=True)
class FetchResult:
    """Результат одного range — формат совместим с Apps Script valueRange."""

    range: str
    values: list[list[Any]] | None  # if render in {both, values}
    formulas: list[list[Any]] | None  # if render in {both, formulas}
    formatted: list[list[Any]] | None  # if render == formatted
    from_cache: bool


def get_ranges(
    conn: sqlite3.Connection,
    api: WebappClient,
    ss_id: str,
    refs: list[RangeRef],
    *,
    render: RenderMode = "both",
    refresh: bool = False,
) -> list[FetchResult]:
    """Получить значения для нескольких ranges. Использует whole-tab кэш для каждого."""
    if not refs:
        return []

    if render == "formatted":
        # FORMATTED_VALUE locale-зависим, не кэшируем — прямой fetch.
        return _fetch_uncached(api, ss_id, refs, value_render="FORMATTED_VALUE")

    metadata = get_metadata(conn, api, ss_id, refresh=refresh)
    results: list[FetchResult] = []
    for ref in refs:
        info = _tab_info(metadata, ref.tab)
        if info is None:
            raise ValueError(
                f"Tab '{ref.tab}' не найден в spreadsheet {ss_id}. "
                f"Доступные: {[t.title for t in metadata]}"
            )

        # Решение: whole-tab cache или fallback на direct fetch.
        est_bytes = info.rows * info.cols * 16  # rough estimate
        max_bytes = get_max_tab_bytes(conn)
        if est_bytes > max_bytes:
            logger.info(
                f"sheet_cache: tab '{ref.tab}' too large for whole-tab cache "
                f"(~{est_bytes // 1024}KB > {max_bytes // 1024}KB), direct fetch"
            )
            results.extend(
                _fetch_uncached(api, ss_id, [ref], value_render=_value_render(render))
            )
            continue

        loaded = None if refresh else _load_tab(conn, ss_id, ref.tab)
        if loaded is None:
            payload = fetch_whole_tab(api, ss_id, info)
            _save_tab(conn, ss_id, ref.tab, payload)
            from_cache = False
        else:
            payload, _ = loaded
            from_cache = True

        results.append(
            _slice_to_result(ref, payload, render=render, from_cache=from_cache)
        )

    return results


def _value_render(render: RenderMode) -> str:
    return {
        "values": "UNFORMATTED_VALUE",
        "formulas": "FORMULA",
        "formatted": "FORMATTED_VALUE",
        "both": "UNFORMATTED_VALUE",  # для direct fetch при `both` берём values
    }.get(render, "UNFORMATTED_VALUE")


def _slice_to_result(
    ref: RangeRef, payload: TabPayload, *, render: RenderMode, from_cache: bool
) -> FetchResult:
    range_str = format_range_a1(ref.tab, ref, payload.dims)
    values = (
        slice_layer(payload.values, ref, payload.dims)
        if render in ("values", "both")
        else None
    )
    formulas = (
        slice_layer(payload.formulas, ref, payload.dims)
        if render in ("formulas", "both")
        else None
    )
    return FetchResult(
        range=range_str,
        values=values,
        formulas=formulas,
        formatted=None,
        from_cache=from_cache,
    )


def _fetch_uncached(
    api: WebappClient, ss_id: str, refs: list[RangeRef], *, value_render: str
) -> list[FetchResult]:
    """Прямой batchGet без кэширования — для `--render formatted` и больших tabs."""
    range_strs = [
        _ref_to_string(r) for r in refs
    ]
    resp = api.batch_get(ss_id, range_strs, value_render=value_render)
    value_ranges = resp.get("valueRanges") or []
    out: list[FetchResult] = []
    for ref, vr in zip(refs, value_ranges, strict=False):
        vals = vr.get("values") or []
        result_range = vr.get("range") or _ref_to_string(ref)
        if value_render == "FORMATTED_VALUE":
            out.append(
                FetchResult(
                    range=result_range, values=None, formulas=None, formatted=vals, from_cache=False
                )
            )
        elif value_render == "FORMULA":
            out.append(
                FetchResult(
                    range=result_range, values=None, formulas=vals, formatted=None, from_cache=False
                )
            )
        else:
            out.append(
                FetchResult(
                    range=result_range, values=vals, formulas=None, formatted=None, from_cache=False
                )
            )
    return out


def _ref_to_string(ref: RangeRef) -> str:
    """Сериализовать RangeRef в строку для Apps Script (без полных dims — open ranges OK)."""
    tab_part = f"'{ref.tab}'" if any(ch in ref.tab for ch in " '!") else ref.tab
    if ref.is_whole_tab:
        return tab_part
    parts: list[str] = []
    for r, c in ((ref.row1, ref.col1), (ref.row2, ref.col2)):
        if r is None and c is None:
            parts.append("")
        elif c is None:
            parts.append(str(r))
        elif r is None:
            parts.append(col_num_to_letters(c))
        else:
            parts.append(f"{col_num_to_letters(c)}{r}")
    span = parts[0] if parts[0] == parts[1] else f"{parts[0]}:{parts[1]}"
    return f"{tab_part}!{span}"
