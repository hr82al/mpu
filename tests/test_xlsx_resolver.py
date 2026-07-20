"""Тесты `lib/xlsx_resolver.py` — приоритет источников пути и алиасы.

Контракт портирован из new-mpu/tests/xlsx-resolve.test.ts и xlsx-aliases.test.ts.
Изолируемся от реального окружения: `env._loaded` фиксируется, `MPU_XLSX` снимается.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from mpu.lib import env, store
from mpu.lib.xlsx_resolver import (
    AliasError,
    XlsxResolveError,
    alias_add,
    alias_list,
    alias_lookup,
    alias_remove,
    expand_path,
    inspect_sources,
    resolve_path,
)


@pytest.fixture
def conn(
    tmp_path: Path,
    bootstrap_db: Callable[[Path | str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[sqlite3.Connection]:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("MPU_XLSX", raising=False)
    db = tmp_path / "mpu.db"
    bootstrap_db(db)
    c = store.open_store(db)
    try:
        yield c
    finally:
        c.close()


def _set_config(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))
    conn.commit()


# ────────────────────────────────────────────────────────────────────────────
# Приоритет источников
# ────────────────────────────────────────────────────────────────────────────


def test_flag_wins_over_env_and_config(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Проверяет: --file/-f перебивает env и config."""
    monkeypatch.setenv("MPU_XLSX", "/from/env.xlsx")
    _set_config(conn, "xlsx.default", "/from/config.xlsx")
    resolved = resolve_path(conn, "/from/flag.xlsx")
    assert resolved.path == Path("/from/flag.xlsx")
    assert resolved.source == "flag"


def test_env_used_when_no_flag(conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    """Проверяет: без флага берётся env MPU_XLSX."""
    monkeypatch.setenv("MPU_XLSX", "/from/env.xlsx")
    _set_config(conn, "xlsx.default", "/from/config.xlsx")
    resolved = resolve_path(conn, None)
    assert resolved.path == Path("/from/env.xlsx")
    assert resolved.source == "env"


def test_config_used_when_flag_and_env_empty(conn: sqlite3.Connection) -> None:
    """Проверяет: пустые flag/env → config xlsx.default."""
    _set_config(conn, "xlsx.default", "/from/config.xlsx")
    resolved = resolve_path(conn, "")
    assert resolved.path == Path("/from/config.xlsx")
    assert resolved.source == "config"


def test_nothing_set_raises_with_all_sources_listed(conn: sqlite3.Connection) -> None:
    """Проверяет: ничего не задано → ошибка перечисляет все три источника."""
    with pytest.raises(XlsxResolveError, match="MPU_XLSX"):
        resolve_path(conn, None)
    assert inspect_sources(conn, None).resolved is None


def test_inspection_marks_used_source(conn: sqlite3.Connection) -> None:
    """Проверяет: в диагностике used стоит ровно у сработавшего источника."""
    checked = inspect_sources(conn, "/x/report.xlsx").checked
    assert [(e.source, e.used, e.value) for e in checked] == [
        ("flag", True, "/x/report.xlsx"),
        ("env", False, None),
        ("config", False, None),
    ]


# ────────────────────────────────────────────────────────────────────────────
# Алиасы
# ────────────────────────────────────────────────────────────────────────────


def test_alias_is_expanded_in_any_slot(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Проверяет: короткое имя раскрывается в путь и в флаге, и в env."""
    alias_add(conn, "report", "/data/report.xlsx")
    from_flag = resolve_path(conn, "report")
    assert from_flag.path == Path("/data/report.xlsx")
    assert from_flag.alias == "report"

    monkeypatch.setenv("MPU_XLSX", "report")
    assert resolve_path(conn, None).alias == "report"


def test_path_like_string_is_not_treated_as_alias(conn: sqlite3.Connection) -> None:
    """Проверяет: строка со слэшем — путь, даже если такой alias существует."""
    alias_add(conn, "report", "/data/report.xlsx")
    resolved = resolve_path(conn, "./report")
    assert resolved.alias is None
    assert resolved.path == Path("report").resolve()


def test_unknown_alias_falls_back_to_path(conn: sqlite3.Connection) -> None:
    """Проверяет: имя без алиаса трактуется как путь (относительный → абсолютный)."""
    resolved = resolve_path(conn, "nosuch")
    assert resolved.alias is None
    assert resolved.path == Path("nosuch").resolve()


def test_alias_roundtrip_upsert_and_removal(conn: sqlite3.Connection) -> None:
    """Проверяет: add → lookup, повторный add = upsert, rm удаляет."""
    alias_add(conn, "r", "/one.xlsx")
    assert alias_lookup(conn, "r") == "/one.xlsx"
    alias_add(conn, "r", "/two.xlsx")
    assert alias_lookup(conn, "r") == "/two.xlsx"
    assert len(alias_list(conn)) == 1
    alias_remove(conn, "r")
    assert alias_lookup(conn, "r") is None


def test_alias_remove_of_missing_is_not_an_error(conn: sqlite3.Connection) -> None:
    """Проверяет: rm несуществующего алиаса молча проходит (идемпотентность)."""
    alias_remove(conn, "ghost")
    assert alias_list(conn) == []


def test_alias_list_is_sorted_by_name(conn: sqlite3.Connection) -> None:
    """Проверяет: ls отсортирован по имени."""
    alias_add(conn, "b", "/b.xlsx")
    alias_add(conn, "a", "/a.xlsx")
    assert [a.name for a in alias_list(conn)] == ["a", "b"]


@pytest.mark.parametrize(("name", "path"), [("with space", "/x.xlsx"), ("ok", "  ")])
def test_alias_validation_rejects_bad_input(conn: sqlite3.Connection, name: str, path: str) -> None:
    """Проверяет: имя с пробелом и пустой путь отвергаются."""
    with pytest.raises(AliasError):
        alias_add(conn, name, path)


# ────────────────────────────────────────────────────────────────────────────
# expand_path
# ────────────────────────────────────────────────────────────────────────────


def test_expand_path_handles_tilde_and_relative() -> None:
    """Проверяет: `~`, `~/x` и относительный путь приводятся к абсолютным."""
    assert expand_path("~") == Path.home()
    assert expand_path("~/foo.xlsx") == Path.home() / "foo.xlsx"
    assert expand_path("foo.xlsx") == Path("foo.xlsx").resolve()
