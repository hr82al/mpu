"""Тесты `lib/sheet_cache.py` — whole-tab кэш, TTL, sweep, invalidation, slicing.

Адаптировано из new-mpu/tests/sheet-cache.test.ts под новую архитектуру
(whole-tab вместо per-cell). Мок WebappClient через `httpx.MockTransport`.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from mpu.lib import store
from mpu.lib.sheet_api import WebappClient
from mpu.lib.sheet_cache import (
    clear_all,
    enforce_size_cap,
    format_range_a1,
    get_ranges,
    invalidate_tab,
    parse_range,
    slice_layer,
    sweep_expired,
)

SS_ID = "SS_X"


# ────────────────────────────────────────────────────────────────────────────
# Фикстуры — мок WebappClient + temp DB
# ────────────────────────────────────────────────────────────────────────────


class _ScriptedTransport:
    """Mock transport: scripted ответы на batchGet / batchUpdate / spreadsheets/get."""

    def __init__(self) -> None:
        self.metadata_response: dict[str, Any] | None = None
        self.batch_get_responses: list[dict[str, Any]] = []
        self.batch_update_responses: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(request.content)
        self.calls.append(body)
        action = body["action"]
        if action == "spreadsheets/get":
            assert self.metadata_response is not None, "metadata not scripted"
            return httpx.Response(
                200, json={"success": True, "result": self.metadata_response}
            )
        if action == "spreadsheets/values/batchGet":
            assert self.batch_get_responses, "batchGet not scripted"
            r = self.batch_get_responses.pop(0)
            return httpx.Response(200, json={"success": True, "result": r})
        if action == "spreadsheets/values/batchUpdate":
            assert self.batch_update_responses, "batchUpdate not scripted"
            r = self.batch_update_responses.pop(0)
            return httpx.Response(200, json={"success": True, "result": r})
        return httpx.Response(500, text=f"unhandled action: {action}")


@pytest.fixture
def conn(
    tmp_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> sqlite3.Connection:
    db = tmp_path / "mpu.db"
    bootstrap_db(db)
    c = store.open_store(db)
    yield c
    c.close()


@pytest.fixture
def scripted() -> _ScriptedTransport:
    return _ScriptedTransport()


@pytest.fixture
def api(scripted: _ScriptedTransport) -> WebappClient:
    return WebappClient(
        url="https://example.test/exec",
        timeout_seconds=5.0,
        max_retries=1,
        quota_delay_seconds=0.001,
        _sleeper=lambda _: None,
        _transport=httpx.MockTransport(scripted.handler),
    )


def _make_meta(tabs: list[tuple[str, int, int]]) -> dict[str, Any]:
    """tabs: [(title, rows, cols), ...] → spreadsheets/get response shape."""
    return {
        "spreadsheetId": SS_ID,
        "sheets": [
            {
                "properties": {
                    "title": title,
                    "sheetId": idx + 1,
                    "index": idx,
                    "gridProperties": {"rowCount": rows, "columnCount": cols},
                }
            }
            for idx, (title, rows, cols) in enumerate(tabs)
        ],
    }


def _make_values_response(range_str: str, values: list[list[Any]]) -> dict[str, Any]:
    return {
        "spreadsheetId": SS_ID,
        "valueRanges": [{"range": range_str, "values": values, "majorDimension": "ROWS"}],
    }


# ────────────────────────────────────────────────────────────────────────────
# Тесты: A1 helpers
# ────────────────────────────────────────────────────────────────────────────


def test_slice_layer_basic() -> None:
    layer = [
        ["a", "b", "c"],
        ["d", "e", "f"],
        ["g", "h", "i"],
    ]
    ref = parse_range("S!B2:C3")
    out = slice_layer(layer, ref, (3, 3))
    assert out == [["e", "f"], ["h", "i"]]


def test_slice_layer_pads_with_empty() -> None:
    """API может вернуть rect меньше запрошенного — паддим '' до прямоугольника."""
    layer = [["x"], ["a", "b"]]
    ref = parse_range("S!A1:C3")
    out = slice_layer(layer, ref, (3, 3))
    assert out == [["x", "", ""], ["a", "b", ""], ["", "", ""]]


def test_format_range_a1_explicit() -> None:
    ref = parse_range("Sheet1!B2:D4")
    assert format_range_a1("Sheet1", ref, (10, 10)) == "Sheet1!B2:D4"


def test_format_range_a1_open_ended_clamped() -> None:
    """`A:A` без верхней границы по строкам → clamp к dims (10 rows)."""
    ref = parse_range("S!A:A")
    assert format_range_a1("S", ref, (10, 5)) == "S!A1:A10"


def test_format_range_a1_quotes_tab_with_space() -> None:
    ref = parse_range("'My Sheet'!A1:B2")
    assert format_range_a1("My Sheet", ref, (10, 10)) == "'My Sheet'!A1:B2"


# ────────────────────────────────────────────────────────────────────────────
# Тесты: whole-tab cache MISS / HIT
# ────────────────────────────────────────────────────────────────────────────


def test_first_read_misses_and_caches_whole_tab(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    scripted.metadata_response = _make_meta([("Sheet1", 3, 3)])
    # Whole-tab fetch: ranges = ['Sheet1!A1:C3'], two passes (UNFORMATTED + FORMULA).
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:C3", [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]]),
        _make_values_response("Sheet1!A1:C3", [["", "", ""], ["", "", ""], ["", "", ""]]),
    ]

    results = get_ranges(
        conn, api, SS_ID, [parse_range("Sheet1!A1:B2")], render="both"
    )
    assert len(results) == 1
    assert results[0].from_cache is False
    assert results[0].values == [["a", "b"], ["d", "e"]]

    # Запись в sheet_tabs.
    row = conn.execute(
        "SELECT tab_name, size_bytes FROM sheet_tabs WHERE ss_id = ?", (SS_ID,)
    ).fetchone()
    assert row["tab_name"] == "Sheet1"
    assert row["size_bytes"] > 0


def test_subsequent_read_is_cache_hit(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    scripted.metadata_response = _make_meta([("Sheet1", 3, 3)])
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:C3", [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]]),
        _make_values_response("Sheet1!A1:C3", [["", "", ""], ["", "", ""], ["", "", ""]]),
    ]
    get_ranges(conn, api, SS_ID, [parse_range("Sheet1!A1:B2")], render="both")

    # Очистим scripted, чтобы второй вызов не был возможен сети.
    scripted.batch_get_responses = []
    results = get_ranges(conn, api, SS_ID, [parse_range("Sheet1!B2:C3")], render="both")
    assert results[0].from_cache is True
    assert results[0].values == [["e", "f"], ["h", "i"]]


def test_ttl_expired_triggers_refetch(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    scripted.metadata_response = _make_meta([("Sheet1", 1, 1)])
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:A1", [["v1"]]),
        _make_values_response("Sheet1!A1:A1", [[""]]),
    ]
    get_ranges(conn, api, SS_ID, [parse_range("Sheet1!A1")], render="both")

    # Состарим запись на 3h (TTL default 2h).
    conn.execute(
        "UPDATE sheet_tabs SET fetched_at = fetched_at - 10800 WHERE ss_id = ?",
        (SS_ID,),
    )
    conn.commit()

    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:A1", [["v2"]]),
        _make_values_response("Sheet1!A1:A1", [[""]]),
    ]
    results = get_ranges(conn, api, SS_ID, [parse_range("Sheet1!A1")], render="both")
    assert results[0].from_cache is False
    assert results[0].values == [["v2"]]


def test_refresh_bypasses_cache(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    scripted.metadata_response = _make_meta([("Sheet1", 1, 1)])
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:A1", [["v1"]]),
        _make_values_response("Sheet1!A1:A1", [[""]]),
    ]
    get_ranges(conn, api, SS_ID, [parse_range("Sheet1!A1")], render="both")

    scripted.metadata_response = _make_meta([("Sheet1", 1, 1)])
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:A1", [["v2"]]),
        _make_values_response("Sheet1!A1:A1", [[""]]),
    ]
    results = get_ranges(
        conn, api, SS_ID, [parse_range("Sheet1!A1")], render="both", refresh=True
    )
    assert results[0].from_cache is False
    assert results[0].values == [["v2"]]


def test_formatted_render_bypasses_whole_tab_cache(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    """`--render formatted` всегда идёт прямым fetch, не используя whole-tab кэш."""
    scripted.batch_get_responses = [
        _make_values_response("Sheet1!A1:B1", [["100,5 ₽", "30%"]]),
    ]
    results = get_ranges(
        conn, api, SS_ID, [parse_range("Sheet1!A1:B1")], render="formatted"
    )
    assert results[0].formatted == [["100,5 ₽", "30%"]]
    # В sheet_tabs ничего не сохранено.
    n = conn.execute("SELECT COUNT(*) AS n FROM sheet_tabs").fetchone()["n"]
    assert n == 0


# ────────────────────────────────────────────────────────────────────────────
# Тесты: invalidation на set
# ────────────────────────────────────────────────────────────────────────────


def test_invalidate_tab_drops_cache_entry(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (SS_ID, "Sheet1", b"\x1f\x8b" + b"\x00" * 10, 12, int(time.time())),
    )
    conn.execute(
        "INSERT INTO cache (key, value, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (f"sheet:info:{SS_ID}", "[]", 100, 200),
    )
    conn.commit()
    invalidate_tab(conn, SS_ID, "Sheet1")
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM sheet_tabs WHERE ss_id = ?", (SS_ID,)
    ).fetchone()["n"]
    assert n == 0
    n_meta = conn.execute(
        "SELECT COUNT(*) AS n FROM cache WHERE key = ?", (f"sheet:info:{SS_ID}",)
    ).fetchone()["n"]
    assert n_meta == 0


# ────────────────────────────────────────────────────────────────────────────
# Тесты: sweep по TTL и enforce_size_cap
# ────────────────────────────────────────────────────────────────────────────


def test_sweep_expired_removes_old_entries(conn: sqlite3.Connection) -> None:
    now = int(time.time())
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES ('A', 'T1', X'1f8b00', 5, ?)",
        (now - 10800,),  # 3h ago — старше TTL=2h
    )
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES ('B', 'T2', X'1f8b00', 5, ?)",
        (now - 100,),  # свежее
    )
    conn.commit()

    deleted = sweep_expired(conn, now=now)
    assert deleted == 1
    rows = conn.execute("SELECT ss_id FROM sheet_tabs").fetchall()
    assert [r["ss_id"] for r in rows] == ["B"]


def test_enforce_size_cap_evicts_oldest(conn: sqlite3.Connection) -> None:
    # Cap = 1MB, поставим три записи по 500KB каждая, общий объём 1.5MB.
    conn.execute(
        "INSERT INTO config (key, value) VALUES ('sheet.cache.max_total_mb', '1')"
    )
    now = int(time.time())
    half_mb = 500 * 1024
    for i, age in enumerate([300, 200, 100]):  # самый старый — first
        conn.execute(
            "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
            "VALUES (?, ?, X'1f8b00', ?, ?)",
            (f"SS_{i}", f"T{i}", half_mb, now - age),
        )
    conn.commit()

    evicted = enforce_size_cap(conn)
    assert evicted >= 1
    total = conn.execute(
        "SELECT COALESCE(SUM(size_bytes), 0) AS t FROM sheet_tabs"
    ).fetchone()["t"]
    assert total <= 1024 * 1024


def test_clear_all_drops_all(conn: sqlite3.Connection) -> None:
    now = int(time.time())
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES ('A', 'T', X'1f', 1, ?)",
        (now,),
    )
    conn.commit()
    n = clear_all(conn)
    assert n == 1
    cnt = conn.execute("SELECT COUNT(*) AS n FROM sheet_tabs").fetchone()["n"]
    assert cnt == 0


# ────────────────────────────────────────────────────────────────────────────
# Тесты: large tab fallback
# ────────────────────────────────────────────────────────────────────────────


def test_large_tab_bypasses_whole_tab_cache(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    """Tab с estimate > sheet.cache.max_tab_bytes → direct fetch, не кэшируем."""
    # Поставим лимит 1KB → 10×10 tab с est_bytes=10*10*16=1600 уже > 1024.
    conn.execute(
        "INSERT INTO config (key, value) VALUES ('sheet.cache.max_tab_bytes', '1024')"
    )
    conn.commit()

    scripted.metadata_response = _make_meta([("Big", 10, 10)])
    scripted.batch_get_responses = [
        _make_values_response("Big!A1:B1", [["a", "b"]]),
    ]

    results = get_ranges(conn, api, SS_ID, [parse_range("Big!A1:B1")], render="values")
    assert results[0].values == [["a", "b"]]
    n = conn.execute("SELECT COUNT(*) AS n FROM sheet_tabs").fetchone()["n"]
    assert n == 0


def test_unknown_tab_raises_value_error(
    conn: sqlite3.Connection, scripted: _ScriptedTransport, api: WebappClient
) -> None:
    scripted.metadata_response = _make_meta([("Sheet1", 3, 3)])
    with pytest.raises(ValueError, match="Tab 'NoSuchTab'"):
        get_ranges(conn, api, SS_ID, [parse_range("NoSuchTab!A1")], render="values")
