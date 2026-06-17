"""Резолв spreadsheet ID из flag / env / config с поддержкой alias / URL / fuzzy.

Источники (по убывающему приоритету):
    1. flag value (`-s/--spreadsheet`)
    2. env `MPU_SS`
    3. config (`sheet.default` в таблице `config`)

Парсинг каждого источника:
    - `https://docs.google.com/spreadsheets/d/<ID>/...` → извлечь ID.
    - 20+ символов `[A-Za-z0-9_-]` → использовать как ID.
    - точное имя из `sheet_aliases` → ss_id.
    - всё цифры → искать в `sl_spreadsheets.client_id`.
    - иначе → fuzzy match по `sl_spreadsheets.title` (case-insensitive substring).
      Несколько матчей → `AmbiguousSpreadsheetError`.

Все операции — только чтение из SQLite, без сети.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Literal

from mpu.lib import env

ResolutionSource = Literal["flag", "env", "config"]
ResolutionKind = Literal["url", "id", "alias", "client_id", "title_fuzzy"]

URL_RE = re.compile(r"https://docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_DIGITS_RE = re.compile(r"^\d+$")


@dataclass(frozen=True)
class ResolvedSpreadsheet:
    ss_id: str
    source: ResolutionSource
    kind: ResolutionKind
    original_input: str


class SpreadsheetResolveError(RuntimeError):
    """База для всех ошибок резолва."""


class SpreadsheetNotFoundError(SpreadsheetResolveError):
    """Ни flag, ни env, ни config не дали значения, либо lookup не нашёл match."""


class AmbiguousSpreadsheetError(SpreadsheetResolveError):
    """Title fuzzy дал >1 кандидат — пользователю надо уточнить."""

    def __init__(self, query: str, candidates: list[tuple[str, str]]) -> None:
        sample = "\n".join(f"  {ss_id}  {title}" for ss_id, title in candidates[:10])
        more = f"\n  …(+{len(candidates) - 10} more)" if len(candidates) > 10 else ""
        super().__init__(
            f"Несколько spreadsheet'ов матчат '{query}':\n{sample}{more}\n"
            f"Уточни через --spreadsheet/-s или используй точный ID/alias."
        )
        self.query = query
        self.candidates = candidates


def _config_get(conn: sqlite3.Connection, key: str) -> str | None:
    try:
        row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return row["value"] if row is not None else None


def _lookup_alias(conn: sqlite3.Connection, name: str) -> str | None:
    try:
        row = conn.execute("SELECT ss_id FROM sheet_aliases WHERE name = ?", (name,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return row["ss_id"] if row is not None else None


def _lookup_by_client_id(conn: sqlite3.Connection, client_id: int) -> list[tuple[str, str]]:
    try:
        rows = conn.execute(
            "SELECT ss_id, title FROM sl_spreadsheets WHERE client_id = ? AND is_active = 1",
            (client_id,),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [(r["ss_id"], r["title"]) for r in rows]


def _lookup_by_title(conn: sqlite3.Connection, query: str) -> list[tuple[str, str]]:
    try:
        rows = conn.execute(
            "SELECT ss_id, title FROM sl_spreadsheets "
            "WHERE LOWER(title) LIKE LOWER(?) AND is_active = 1 "
            "ORDER BY title",
            (f"%{query}%",),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [(r["ss_id"], r["title"]) for r in rows]


def parse_input(input_str: str, conn: sqlite3.Connection) -> tuple[str, ResolutionKind]:
    """Резолв одной строки → (ss_id, kind). Бросает Not/AmbiguousError."""
    s = input_str.strip()
    if not s:
        raise SpreadsheetNotFoundError("Пустая строка не может быть spreadsheet input'ом.")

    m = URL_RE.search(s)
    if m:
        return m.group(1), "url"

    if ID_RE.match(s):
        return s, "id"

    alias_id = _lookup_alias(conn, s)
    if alias_id is not None:
        return alias_id, "alias"

    if _DIGITS_RE.match(s):
        matches = _lookup_by_client_id(conn, int(s))
        if len(matches) == 1:
            return matches[0][0], "client_id"
        if len(matches) > 1:
            raise AmbiguousSpreadsheetError(s, matches)
        raise SpreadsheetNotFoundError(
            f"client_id={s} не найден в sl_spreadsheets. "
            f"Запусти `mpu sheet sync` чтобы обновить кэш."
        )

    matches = _lookup_by_title(conn, s)
    if len(matches) == 1:
        return matches[0][0], "title_fuzzy"
    if len(matches) > 1:
        raise AmbiguousSpreadsheetError(s, matches)
    raise SpreadsheetNotFoundError(
        f"Spreadsheet '{s}' не найден ни как ID/URL/alias/client_id/title. "
        f"Запусти `mpu sheet sync` чтобы обновить кэш."
    )


def resolve(flag_value: str | None, conn: sqlite3.Connection) -> ResolvedSpreadsheet:
    """Pipeline: flag → env MPU_SS → config sheet.default → parse_input."""
    candidates: list[tuple[str | None, ResolutionSource]] = [
        (flag_value, "flag"),
        (env.get("MPU_SS"), "env"),
        (_config_get(conn, "sheet.default"), "config"),
    ]
    for value, source in candidates:
        if value:
            ss_id, kind = parse_input(value, conn)
            return ResolvedSpreadsheet(ss_id=ss_id, source=source, kind=kind, original_input=value)
    raise SpreadsheetNotFoundError(
        "Spreadsheet не указан. Используй --spreadsheet/-s, "
        "export MPU_SS=<id-or-name>, или установи `sheet.default` в config."
    )
