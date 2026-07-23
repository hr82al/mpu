"""Тесты `lib/resolver.py` — резолв селектора в server_number."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from mpu.lib import servers, store
from mpu.lib.resolver import (
    ResolveError,
    require_single_client_id,
    resolve_server,
    resolve_server_or_exit,
)


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


# ────────────────────────────────────────────────────────────────────────────
# resolve_server_or_exit / require_single_client_id — общие обёртки для команд
# ────────────────────────────────────────────────────────────────────────────


def test_resolve_server_or_exit_passes_through(db: None) -> None:
    """Успешный резолв — те же (server_number, candidates), что у resolve_server."""
    assert resolve_server_or_exit("sl-2", command_name="mpu foo") == (2, [])


def test_resolve_server_or_exit_prints_candidates_and_exits(
    db: None, capsys: pytest.CaptureFixture[str]
) -> None:
    """Неоднозначный селектор → сообщение с префиксом команды, кандидаты, выход 2."""
    with pytest.raises(SystemExit) as exc_info:
        resolve_server_or_exit("Тортуга", command_name="mpu foo")
    assert exc_info.value.code == 2
    err = capsys.readouterr().err
    assert err.startswith("mpu foo: ambiguous selector 'Тортуга'")
    assert "client_id=10" in err and "client_id=20" in err


def test_resolve_server_or_exit_without_candidates(
    db: None, capsys: pytest.CaptureFixture[str]
) -> None:
    """Ничего не нашлось — только строка ошибки, без блока кандидатов."""
    with pytest.raises(SystemExit) as exc_info:
        resolve_server_or_exit("нет-такого", command_name="mpu foo")
    assert exc_info.value.code == 2
    assert capsys.readouterr().err == "mpu foo: nothing matched: 'нет-такого'\n"


def test_require_single_client_id_returns_the_only_id() -> None:
    candidates: list[dict[str, object]] = [{"client_id": 42, "server": "sl-1"}]
    assert (
        require_single_client_id(candidates, selector="x", server_number=1, command_name="mpu foo")
        == 42
    )


def test_require_single_client_id_empty_candidates(capsys: pytest.CaptureFixture[str]) -> None:
    """Пустой список — селектор указал на сервер, но не на клиента."""
    with pytest.raises(SystemExit) as exc_info:
        require_single_client_id([], selector="sl-1", server_number=1, command_name="mpu foo")
    assert exc_info.value.code == 2
    assert capsys.readouterr().err == (
        "mpu foo: selector 'sl-1' resolved to sl-1 but does not point to a specific client; "
        "pass client_id / spreadsheet / title\n"
    )


def test_require_single_client_id_no_int_ids(capsys: pytest.CaptureFixture[str]) -> None:
    """Кандидаты есть, но без client_id — отдельное сообщение + список кандидатов."""
    candidates: list[dict[str, object]] = [{"server": "sl-1", "title": "без id"}]
    with pytest.raises(SystemExit) as exc_info:
        require_single_client_id(candidates, selector="x", server_number=1, command_name="mpu foo")
    assert exc_info.value.code == 2
    err = capsys.readouterr().err
    assert err.startswith("mpu foo: selector resolved to a server but no client_id;")
    assert 'title="без id"' in err


def test_require_single_client_id_ambiguous(capsys: pytest.CaptureFixture[str]) -> None:
    candidates: list[dict[str, object]] = [
        {"client_id": 1, "server": "sl-1"},
        {"client_id": 2, "server": "sl-1"},
    ]
    with pytest.raises(SystemExit) as exc_info:
        require_single_client_id(candidates, selector="x", server_number=1, command_name="mpu foo")
    assert exc_info.value.code == 2
    err = capsys.readouterr().err
    assert err.startswith("mpu foo: selector matches 2 clients — narrow it down")
    assert "client_id=1" in err and "client_id=2" in err
