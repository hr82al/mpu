"""Тест `commands/update.py` с заглушкой psycopg-соединения."""

from pathlib import Path
from typing import Any

import psycopg
import pytest

from mpu.commands import update
from mpu.lib import store


def _make_fake_pg(
    clients_rows: list[tuple[Any, ...]],
    spreadsheets_per_server: dict[int, list[tuple[Any, ...]]],
    wb_sids_rows: list[tuple[Any, ...]] | None = None,
):
    """Возвращает (connect_main_fn, connect_to_fn) которые отдают заглушки.

    Курсор query-aware: на main запрос с `wb_tokens` отдаёт `wb_sids_rows`
    (DISTINCT client_id, sid), любой другой — `clients_rows`.
    """
    sids_rows = wb_sids_rows if wb_sids_rows is not None else []

    class _Cur:
        def __init__(self, default_rows: list[tuple[Any, ...]]) -> None:
            self._default = default_rows
            self._q = ""

        def execute(self, q: str) -> None:
            self._q = q

        def fetchall(self) -> list[tuple[Any, ...]]:
            if "wb_tokens" in self._q:
                return sids_rows
            return self._default

        def __enter__(self) -> "_Cur":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    class _Conn:
        def __init__(self, rows: list[tuple[Any, ...]]) -> None:
            self._cur = _Cur(rows)

        def cursor(self) -> _Cur:
            return self._cur

        def __enter__(self) -> "_Conn":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def fake_connect_main() -> _Conn:
        return _Conn(clients_rows)

    def fake_connect_to(n: int, *, timeout: int = 10) -> _Conn:
        return _Conn(spreadsheets_per_server.get(n, []))

    return fake_connect_main, fake_connect_to


def test_run_update_iterates_all_servers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    clients_rows = [
        (10, "sl-1", True, False, False),
        (20, "sl-2", True, True, False),
        (30, "sl-1", True, False, False),
    ]
    ss_per_server = {
        1: [
            # client_id, spreadsheet_id, title, template_name, is_active
            (10, "ss10a", "T10a", "tmpl", True),
            (10, "ss10b", "T10b", None, True),
            (30, "ss30", "T30", "tmpl", False),
        ],
        2: [
            (20, "ss20", "T20", "tmpl", True),
        ],
    }
    fake_main, fake_to = _make_fake_pg(clients_rows, ss_per_server)
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    n_clients, n_ss, _elapsed = update.run_update(quiet=True)
    assert n_clients == 3
    assert n_ss == 4

    with store.store(db_path) as conn:
        rows = conn.execute(
            "SELECT client_id, server FROM sl_clients ORDER BY client_id"
        ).fetchall()
        assert [tuple(r) for r in rows] == [(10, "sl-1"), (20, "sl-2"), (30, "sl-1")]
        ss_rows = conn.execute(
            "SELECT ss_id, client_id, title, server FROM sl_spreadsheets ORDER BY ss_id"
        ).fetchall()
        assert [tuple(r) for r in ss_rows] == [
            ("ss10a", 10, "T10a", "sl-1"),
            ("ss10b", 10, "T10b", "sl-1"),
            ("ss20", 20, "T20", "sl-2"),
            ("ss30", 30, "T30", "sl-1"),
        ]


def test_run_update_replaces_old_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Второй update полностью заменяет старые данные."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    fake_main, fake_to = _make_fake_pg(
        [(10, "sl-1", True, False, False)],
        {1: [(10, "ss1", "T", None, True)]},
    )
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)
    update.run_update(quiet=True)

    fake_main, fake_to = _make_fake_pg(
        [(11, "sl-2", True, False, False)],
        {2: [(11, "ss2", "T2", None, True)]},
    )
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)
    update.run_update(quiet=True)

    with store.store(db_path) as conn:
        ids = [r[0] for r in conn.execute("SELECT client_id FROM sl_clients").fetchall()]
        assert ids == [11]
        ss_ids = [r[0] for r in conn.execute("SELECT ss_id FROM sl_spreadsheets").fetchall()]
        assert ss_ids == ["ss2"]


def test_run_update_handles_failed_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Если один инстанс не отвечает — остальные всё равно синкаются."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    clients_rows = [
        (10, "sl-1", True, False, False),
        (20, "sl-2", True, False, False),
    ]
    ss_per_server: dict[int, list[tuple[Any, ...]]] = {
        1: [(10, "ssA", "TA", None, True)],
        # 2 не отвечает — конфигурируем через side-effect ниже
    }
    fake_main, _real_fake_to = _make_fake_pg(clients_rows, ss_per_server)

    def flaky_connect_to(n: int, *, timeout: int = 10):
        if n == 2:
            raise psycopg.OperationalError("boom: connection refused")
        return _real_fake_to(n, timeout=timeout)

    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", flaky_connect_to)

    n_clients, n_ss, _ = update.run_update(quiet=True)
    assert n_clients == 2
    assert n_ss == 1  # только sl-1
    with store.store(db_path) as conn:
        ss_rows = conn.execute("SELECT ss_id, server FROM sl_spreadsheets").fetchall()
        assert [tuple(r) for r in ss_rows] == [("ssA", "sl-1")]


def test_run_update_populates_wb_sids(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """wb_tokens → sl_wb_sids: server из clients-карты; неизвестный клиент отброшен."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    clients_rows = [(10, "sl-1", True, False, False), (20, "sl-2", True, False, False)]
    ss_per_server = {1: [(10, "ss10", "T", None, True)]}
    wb_sids = [
        (10, "sid-a"),
        (10, "sid-b"),
        (20, "sid-c"),
        (999, "sid-orphan"),  # клиента нет в clients → отбрасывается
    ]
    fake_main, fake_to = _make_fake_pg(clients_rows, ss_per_server, wb_sids)
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    update.run_update(quiet=True)

    with store.store(db_path) as conn:
        rows = conn.execute("SELECT sid, client_id, server FROM sl_wb_sids ORDER BY sid").fetchall()
        assert [tuple(r) for r in rows] == [
            ("sid-a", 10, "sl-1"),
            ("sid-b", 10, "sl-1"),
            ("sid-c", 20, "sl-2"),
        ]


def test_run_update_self_heals_missing_sl_wb_sids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Старый кэш без sl_wb_sids: run_update сам добутстрапит таблицу, не падает."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as conn:
        store.bootstrap(conn)
        conn.execute("DROP TABLE sl_wb_sids")
        conn.commit()

    fake_main, fake_to = _make_fake_pg(
        [(10, "sl-1", True, False, False)],
        {1: [(10, "ss1", "T", None, True)]},
        [(10, "sid-x")],
    )
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    update.run_update(quiet=True)  # не должно бросить OperationalError

    with store.store(db_path) as conn:
        rows = conn.execute("SELECT sid, client_id FROM sl_wb_sids").fetchall()
        assert [tuple(r) for r in rows] == [("sid-x", 10)]
