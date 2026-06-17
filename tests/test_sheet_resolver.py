"""Тесты `lib/sheet_resolver.py` — резолв ID / URL / alias / fuzzy."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest

from mpu.lib import store
from mpu.lib.sheet_resolver import (
    AmbiguousSpreadsheetError,
    SpreadsheetNotFoundError,
    parse_input,
    resolve,
)


@pytest.fixture
def conn(tmp_path: Path, bootstrap_db: Callable[[Path | str], None]) -> sqlite3.Connection:
    db = tmp_path / "mpu.db"
    bootstrap_db(db)
    c = store.open_store(db)
    # Поместим тестовые spreadsheets.
    c.execute(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("1abc" + "X" * 40, 42, "Иванов И.И.", "wb10xMain", 1, "sl-1", 100),
    )
    c.execute(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("2def" + "Y" * 40, 99, "Петров П.П.", "ozon10xMain", 1, "sl-2", 100),
    )
    c.execute(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("3ghi" + "Z" * 40, 100, "Петрова А.А.", "wb10xMain", 1, "sl-2", 100),
    )
    c.execute(
        "INSERT INTO sheet_aliases (name, ss_id, created_at) VALUES (?, ?, ?)",
        ("test", "0test" + "T" * 40, 100),
    )
    c.commit()
    yield c
    c.close()


def test_parse_input_url(conn: sqlite3.Connection) -> None:
    ss_id, kind = parse_input("https://docs.google.com/spreadsheets/d/1abcXYZ123/edit#gid=0", conn)
    assert ss_id == "1abcXYZ123"
    assert kind == "url"


def test_parse_input_raw_id(conn: sqlite3.Connection) -> None:
    ss_id, kind = parse_input("1abc" + "X" * 40, conn)
    assert ss_id == "1abc" + "X" * 40
    assert kind == "id"


def test_parse_input_alias(conn: sqlite3.Connection) -> None:
    ss_id, kind = parse_input("test", conn)
    assert ss_id == "0test" + "T" * 40
    assert kind == "alias"


def test_parse_input_client_id(conn: sqlite3.Connection) -> None:
    ss_id, kind = parse_input("42", conn)
    assert ss_id == "1abc" + "X" * 40
    assert kind == "client_id"


def test_parse_input_title_fuzzy_unique(conn: sqlite3.Connection) -> None:
    ss_id, kind = parse_input("Иванов", conn)
    assert ss_id == "1abc" + "X" * 40
    assert kind == "title_fuzzy"


def test_parse_input_title_fuzzy_ambiguous(conn: sqlite3.Connection) -> None:
    with pytest.raises(AmbiguousSpreadsheetError) as exc:
        parse_input("Петров", conn)
    assert len(exc.value.candidates) == 2


def test_parse_input_not_found(conn: sqlite3.Connection) -> None:
    with pytest.raises(SpreadsheetNotFoundError):
        parse_input("Несуществующий-666", conn)


def test_parse_input_empty(conn: sqlite3.Connection) -> None:
    with pytest.raises(SpreadsheetNotFoundError):
        parse_input("   ", conn)


def test_resolve_flag_wins(conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MPU_SS", "42")
    result = resolve("Иванов", conn)
    assert result.source == "flag"
    assert result.ss_id == "1abc" + "X" * 40


def test_resolve_env_when_no_flag(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    # env.get использует dotenv который кэширует — заходим напрямую через os.environ.
    from mpu.lib import env as env_mod

    monkeypatch.setattr(env_mod, "_loaded", True)
    monkeypatch.setenv("MPU_SS", "42")
    result = resolve(None, conn)
    assert result.source == "env"
    assert result.ss_id == "1abc" + "X" * 40


def test_resolve_config_fallback(conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpu.lib import env as env_mod

    monkeypatch.setattr(env_mod, "_loaded", True)
    monkeypatch.delenv("MPU_SS", raising=False)
    conn.execute("INSERT INTO config (key, value) VALUES (?, ?)", ("sheet.default", "test"))
    conn.commit()
    result = resolve(None, conn)
    assert result.source == "config"
    assert result.ss_id == "0test" + "T" * 40
    assert result.kind == "alias"


def test_resolve_nothing_set(conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    from mpu.lib import env as env_mod

    monkeypatch.setattr(env_mod, "_loaded", True)
    monkeypatch.delenv("MPU_SS", raising=False)
    with pytest.raises(SpreadsheetNotFoundError):
        resolve(None, conn)
