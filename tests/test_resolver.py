"""Тесты `lib/resolver.py` — резолв селектора в server_number."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from mpu.lib import servers, store
from mpu.lib.resolver import ResolveError, resolve_server


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)

    env = tmp_path / ".env"
    env.write_text("sl_1='10.0.0.1'\nsl_2='10.0.0.2'\npg_1='10.1.0.1'\npg_2='10.1.0.2'\n")
    monkeypatch.setattr(servers, "ENV_PATH", env)
    servers.reset_cache()

    conn = store.open_store(db_path)
    store.bootstrap(conn)
    conn.executemany(
        "INSERT INTO sl_clients "
        "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (10, "sl-1", 1, 0, 0, 100),
            (20, "sl-2", 1, 0, 0, 100),
        ],
    )
    conn.executemany(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("ssA", 10, "Тортуга main", "tmpl", 1, "sl-1", 100),
            ("ssA2", 10, "Тортуга second", "tmpl", 1, "sl-1", 100),
            ("ssB", 20, "Тортуга side", "tmpl", 1, "sl-2", 100),
        ],
    )
    conn.commit()
    conn.close()
    yield
    servers.reset_cache()


def test_resolve_by_client_id(db: None) -> None:
    n, candidates = resolve_server("10")
    assert n == 1
    assert {c["client_id"] for c in candidates} == {10}


def test_resolve_sl_n_short_circuit(db: None) -> None:
    """`sl-N` в value — шорт-цикл, поиск пропускается."""
    n, candidates = resolve_server("sl-7")
    assert n == 7
    assert candidates == []


def test_resolve_sl_0_short_circuit(db: None) -> None:
    """sl-0 — валидный server_number=0 (callers сами решают, отвергать ли)."""
    n, candidates = resolve_server("sl-0")
    assert n == 0
    assert candidates == []


def test_resolve_single_server_multiple_rows_ok(db: None) -> None:
    n, candidates = resolve_server("Тортуга main")
    assert n == 1
    assert len(candidates) == 1


def test_resolve_ambiguous_raises_with_candidates(db: None) -> None:
    with pytest.raises(ResolveError) as ei:
        resolve_server("Тортуга")
    assert ei.value.candidates
    distinct = {c["server_number"] for c in ei.value.candidates}
    assert distinct == {1, 2}


def test_resolve_empty_raises(db: None) -> None:
    with pytest.raises(ResolveError) as ei:
        resolve_server("DEFINITELY_NOT_THERE_xyz")
    assert ei.value.candidates == []


def test_resolve_server_override(db: None) -> None:
    n, candidates = resolve_server("ignored-by-override", server_override="sl-3")
    assert n == 3
    assert candidates == []


def test_resolve_server_override_bad(db: None) -> None:
    with pytest.raises(ResolveError):
        resolve_server("anything", server_override="garbage")


def test_resolve_by_pg_ip(db: None) -> None:
    """IP из `.env` (`pg_2='10.1.0.2'`) → server_number=2 через search-fallback."""
    n, candidates = resolve_server("10.1.0.2")
    assert n == 2
    assert len(candidates) == 1
    assert candidates[0]["server_number"] == 2
    assert candidates[0]["client_id"] is None


def test_resolve_by_sl_ip(db: None) -> None:
    n, _ = resolve_server("10.0.0.1")
    assert n == 1


def test_resolve_unknown_ip_raises(db: None) -> None:
    with pytest.raises(ResolveError) as ei:
        resolve_server("9.9.9.9")
    assert ei.value.candidates == []


@pytest.fixture
def db_no_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    env = tmp_path / ".env"
    env.write_text("")
    monkeypatch.setattr(servers, "ENV_PATH", env)
    servers.reset_cache()

    conn = store.open_store(db_path)
    store.bootstrap(conn)
    cur: sqlite3.Cursor = conn.executemany(
        "INSERT INTO sl_clients "
        "(client_id, server, is_active, is_locked, is_deleted, synced_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(50, None, 1, 0, 0, 100)],
    )
    del cur
    conn.commit()
    conn.close()
    yield
    servers.reset_cache()


def test_resolve_no_server_in_results(db_no_server: None) -> None:
    with pytest.raises(ResolveError) as ei:
        resolve_server("50")
    assert "no server resolvable" in str(ei.value)
    assert ei.value.candidates
