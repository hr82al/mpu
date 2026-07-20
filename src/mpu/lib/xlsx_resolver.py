"""Резолв пути к локальному `.xlsx` + алиасы коротких имён.

Источники (по убывающему приоритету):
    1. flag value (`-f/--file`)
    2. env `MPU_XLSX`
    3. config (`xlsx.default` в таблице `config`)

В каждом слоте значение сперва пробуется как alias — если оно не похоже на путь
(нет `/`, `\\`, не начинается с `~`, не кончается на `.xlsx`) и состоит из
`[A-Za-z0-9_.-]`. Иначе — как путь: `~` раскрывается, остальное приводится к
абсолютному относительно cwd.

Алиасы живут в таблице `xlsx_aliases`; путь хранится как введён и раскрывается
при резолве — переносимо между машинами.

Все операции — только чтение/запись локального SQLite, без сети.
"""

from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from mpu.lib import env

__all__ = [
    "SOURCE_LABELS",
    "Alias",
    "AliasError",
    "Inspection",
    "Resolved",
    "SourceEntry",
    "XlsxResolveError",
    "alias_add",
    "alias_list",
    "alias_lookup",
    "alias_remove",
    "expand_path",
    "inspect_sources",
    "resolve_path",
]

ResolutionSource = Literal["flag", "env", "config"]

ALIAS_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

SOURCE_LABELS: dict[ResolutionSource, str] = {
    "flag": "--file/-f",
    "env": "env MPU_XLSX",
    "config": "config xlsx.default",
}


class XlsxResolveError(RuntimeError):
    """Ни flag, ни env, ни config не дали пути."""


class AliasError(ValueError):
    """Невалидное имя алиаса или пустой путь."""


@dataclass(frozen=True)
class Resolved:
    path: Path
    source: ResolutionSource
    alias: str | None = None


@dataclass(frozen=True)
class SourceEntry:
    source: ResolutionSource
    label: str
    value: str | None
    used: bool


@dataclass(frozen=True)
class Inspection:
    checked: list[SourceEntry]
    resolved: Resolved | None


@dataclass(frozen=True)
class Alias:
    name: str
    path: str
    created_at: int


# ────────────────────────────────────────────────────────────────────────────
# Алиасы (таблица xlsx_aliases)
# ────────────────────────────────────────────────────────────────────────────


def alias_add(conn: sqlite3.Connection, name: str, path: str) -> Alias:
    """Создать или заменить alias. Путь сохраняется как введён."""
    if not ALIAS_NAME_RE.match(name):
        raise AliasError(f"невалидное имя алиаса '{name}' (допустимо [A-Za-z0-9_.-]+)")
    if not path.strip():
        raise AliasError("путь не может быть пустым")
    created_at = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO xlsx_aliases (name, path, created_at) VALUES (?, ?, ?) "
        "ON CONFLICT(name) DO UPDATE SET path = excluded.path, created_at = excluded.created_at",
        (name, path, created_at),
    )
    conn.commit()
    return Alias(name=name, path=path, created_at=created_at)


def alias_list(conn: sqlite3.Connection) -> list[Alias]:
    try:
        rows = conn.execute(
            "SELECT name, path, created_at FROM xlsx_aliases ORDER BY name"
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [Alias(name=r["name"], path=r["path"], created_at=r["created_at"]) for r in rows]


def alias_remove(conn: sqlite3.Connection, name: str) -> None:
    """Удалить alias. Удаление несуществующего — не ошибка."""
    try:
        conn.execute("DELETE FROM xlsx_aliases WHERE name = ?", (name,))
    except sqlite3.OperationalError:
        return
    conn.commit()


def alias_lookup(conn: sqlite3.Connection, name: str) -> str | None:
    try:
        row = conn.execute("SELECT path FROM xlsx_aliases WHERE name = ?", (name,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return row["path"] if row is not None else None


# ────────────────────────────────────────────────────────────────────────────
# Резолв пути
# ────────────────────────────────────────────────────────────────────────────


def expand_path(raw: str) -> Path:
    """`~`/`~/x` → домашний каталог; остальное — абсолютный путь от cwd."""
    if raw == "~":
        return Path.home()
    if raw.startswith("~/"):
        return Path.home() / raw[2:]
    return Path(raw).resolve()


def _looks_like_path(s: str) -> bool:
    return "/" in s or "\\" in s or s.startswith("~") or s.endswith(".xlsx")


def _config_get(conn: sqlite3.Connection, key: str) -> str | None:
    try:
        row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return row["value"] if row is not None else None


def inspect_sources(conn: sqlite3.Connection, flag_value: str | None) -> Inspection:
    """Прогнать все источники по порядку — для `xlsx resolve` и обычного резолва."""
    raw_by_source: list[tuple[ResolutionSource, str | None]] = [
        ("flag", flag_value or None),
        ("env", env.get("MPU_XLSX") or None),
        ("config", _config_get(conn, "xlsx.default") or None),
    ]

    resolved: Resolved | None = None
    for source, raw in raw_by_source:
        if resolved is not None or raw is None:
            continue
        if not _looks_like_path(raw) and ALIAS_NAME_RE.match(raw):
            alias_target = alias_lookup(conn, raw)
            if alias_target is not None:
                resolved = Resolved(path=expand_path(alias_target), source=source, alias=raw)
                continue
        resolved = Resolved(path=expand_path(raw), source=source)

    checked = [
        SourceEntry(
            source=source,
            label=SOURCE_LABELS[source],
            value=raw,
            used=resolved is not None and resolved.source == source,
        )
        for source, raw in raw_by_source
    ]
    return Inspection(checked=checked, resolved=resolved)


def resolve_path(conn: sqlite3.Connection, flag_value: str | None) -> Resolved:
    """Первый непустой источник → путь. Иначе — `XlsxResolveError` с подсказкой."""
    resolved = inspect_sources(conn, flag_value).resolved
    if resolved is not None:
        return resolved
    raise XlsxResolveError(
        "путь к .xlsx не задан. Проверены (по порядку): --file/-f, "
        "env MPU_XLSX, config xlsx.default"
    )
