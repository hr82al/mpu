"""Тест `commands/update.py` с заглушкой psycopg-соединения."""

from pathlib import Path
from typing import Any

import psycopg
import pytest
from typer.testing import CliRunner

from mpu.commands import update
from mpu.lib import store
from mpu.lib.loki_discover import DiscoveryResult


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


# --- summary output (non-quiet) -------------------------------------------------


def _quiet_loki() -> DiscoveryResult:
    """Заглушка discover_and_store: пустой best-effort результат без сети."""
    return DiscoveryResult(hosts=[], services_by_host={}, error="LOKI_URL не задан")


def test_run_update_prints_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`quiet=False`: печатает сводку clients/spreadsheets/sids + успешный Loki."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    clients_rows = [(10, "sl-1", True, False, False)]
    ss_per_server = {1: [(10, "ss10", "T", None, True)]}
    fake_main, fake_to = _make_fake_pg(clients_rows, ss_per_server, [(10, "sid-a")])
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    def fake_loki() -> DiscoveryResult:
        return DiscoveryResult(
            hosts=["h1", "h2"],
            services_by_host={"h1": ["s1", "s2"], "h2": ["s3"]},
            error=None,
        )

    monkeypatch.setattr("mpu.commands.update.loki_discover.discover_and_store", fake_loki)

    update.run_update(quiet=False)

    out = capsys.readouterr()
    assert "clients: 1 rows" in out.out
    assert "spreadsheets: 1 rows from 1 servers" in out.out
    assert "wb sids: 1 rows" in out.out
    # 2 hosts, services s1+s2+s3 = 3 пары
    assert "loki: 2 hosts, 3 (host, service) пар" in out.out


def test_run_update_summary_loki_error_and_failed_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`quiet=False`: Loki-ошибка и упавший сервер уходят в stderr-предупреждения."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    clients_rows = [
        (10, "sl-1", True, False, False),
        (20, "sl-2", True, False, False),
    ]
    ss_per_server: dict[int, list[tuple[Any, ...]]] = {1: [(10, "ssA", "TA", None, True)]}
    fake_main, real_fake_to = _make_fake_pg(clients_rows, ss_per_server)

    def flaky_connect_to(n: int, *, timeout: int = 10):
        if n == 2:
            raise psycopg.OperationalError("boom: connection refused\nsecond line")
        return real_fake_to(n, timeout=timeout)

    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", flaky_connect_to)
    monkeypatch.setattr("mpu.commands.update.loki_discover.discover_and_store", _quiet_loki)

    update.run_update(quiet=False)

    err = capsys.readouterr().err
    assert "loki: пропущено (LOKI_URL не задан)" in err
    # only first line of the exception message, без "second line"
    assert "warning: failed to query servers: sl-2 (boom: connection refused)" in err
    assert "second line" not in err


# --- fetch_single_client --------------------------------------------------------


def _make_fake_pg_single(
    client_row: tuple[Any, ...] | None,
    ss_rows: list[tuple[Any, ...]],
    sid_rows: list[tuple[Any, ...]],
):
    """connect_main/connect_to для `fetch_single_client`.

    Контракт курсора отличается от `_make_fake_pg`: `fetch_single_client` шлёт
    параметризованные запросы (`execute(q, params)`), читает клиента через
    `fetchone`, а sids/spreadsheets — через `fetchall` (sids — по `wb_tokens`).
    """

    class _Cur:
        def __init__(self) -> None:
            self._q = ""

        def execute(self, q: str, params: tuple[Any, ...] | None = None) -> None:
            self._q = q

        def fetchone(self) -> tuple[Any, ...] | None:
            return client_row

        def fetchall(self) -> list[tuple[Any, ...]]:
            if "wb_tokens" in self._q:
                return sid_rows
            return ss_rows

        def __enter__(self) -> "_Cur":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    class _Conn:
        def cursor(self) -> _Cur:
            return _Cur()

        def __enter__(self) -> "_Conn":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def fake_connect_main() -> _Conn:
        return _Conn()

    def fake_connect_to(n: int, *, timeout: int = 10) -> _Conn:
        return _Conn()

    return fake_connect_main, fake_connect_to


def test_fetch_single_client_happy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Клиент найден на main: пишет client + spreadsheets + sids, возвращает True."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    client_row = (42, "sl-1", True, False, False)
    ss_rows = [
        # client_id, spreadsheet_id, title, template_name, is_active
        (42, "ss42", "T42", "tmpl", True),
        (42, "ss42b", None, None, False),  # title None → "" в кэше
    ]
    sid_rows = [(42, "sid-1"), (42, "sid-2")]
    fake_main, fake_to = _make_fake_pg_single(client_row, ss_rows, sid_rows)
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    assert update.fetch_single_client(42) is True

    with store.store(db_path) as conn:
        crows = conn.execute("SELECT client_id, server, is_active FROM sl_clients").fetchall()
        assert [tuple(r) for r in crows] == [(42, "sl-1", 1)]
        ss = conn.execute(
            "SELECT ss_id, client_id, title, is_active, server FROM sl_spreadsheets ORDER BY ss_id"
        ).fetchall()
        assert [tuple(r) for r in ss] == [
            ("ss42", 42, "T42", 1, "sl-1"),
            ("ss42b", 42, "", 0, "sl-1"),
        ]
        sids = conn.execute("SELECT sid, client_id, server FROM sl_wb_sids ORDER BY sid").fetchall()
        assert [tuple(r) for r in sids] == [
            ("sid-1", 42, "sl-1"),
            ("sid-2", 42, "sl-1"),
        ]


def test_fetch_single_client_not_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Клиента нет на main (fetchone → None): возвращает False, ничего не пишет."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    fake_main, fake_to = _make_fake_pg_single(None, [], [])
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    assert update.fetch_single_client(999) is False

    with store.store(db_path) as conn:
        assert conn.execute("SELECT client_id FROM sl_clients").fetchall() == []


def test_fetch_single_client_main_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """connect_main падает → возвращает False (best-effort, без записи)."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    def boom_main():
        raise psycopg.OperationalError("no main")

    monkeypatch.setattr("mpu.commands.update.pg.connect_main", boom_main)

    assert update.fetch_single_client(5) is False
    with store.store(db_path) as conn:
        assert conn.execute("SELECT client_id FROM sl_clients").fetchall() == []


def test_fetch_single_client_non_instance_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """server без sl-N (`sl-0`, n<=0): spreadsheets не тянутся, server_name = исходный."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    client_row = (7, "sl-0", True, False, False)
    sid_rows = [(7, "sid-z")]
    fake_main, fake_to = _make_fake_pg_single(client_row, [], sid_rows)
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    assert update.fetch_single_client(7) is True

    with store.store(db_path) as conn:
        assert conn.execute("SELECT ss_id FROM sl_spreadsheets").fetchall() == []
        crows = conn.execute("SELECT client_id, server FROM sl_clients").fetchall()
        assert [tuple(r) for r in crows] == [(7, "sl-0")]
        sids = conn.execute("SELECT sid, client_id, server FROM sl_wb_sids").fetchall()
        assert [tuple(r) for r in sids] == [("sid-z", 7, "sl-0")]


def test_fetch_single_client_ss_fetch_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """connect_to падает: spreadsheets деградируют в [], client + sids всё равно пишутся."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    client_row = (8, "sl-1", True, False, False)
    sid_rows = [(8, "sid-q")]
    fake_main, _ = _make_fake_pg_single(client_row, [], sid_rows)

    def boom_to(n: int, *, timeout: int = 10):
        raise psycopg.OperationalError("ss boom")

    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", boom_to)

    assert update.fetch_single_client(8) is True

    with store.store(db_path) as conn:
        assert conn.execute("SELECT ss_id FROM sl_spreadsheets").fetchall() == []
        sids = conn.execute("SELECT sid, client_id, server FROM sl_wb_sids").fetchall()
        assert [tuple(r) for r in sids] == [("sid-q", 8, "sl-1")]


def test_fetch_single_client_sid_fetch_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """wb_tokens-запрос падает: sids деградируют в [], client + spreadsheets пишутся."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    client_row = (9, "sl-1", True, False, False)
    ss_rows = [(9, "ss9", "T9", "tmpl", True)]
    fake_main_ok, fake_to = _make_fake_pg_single(client_row, ss_rows, [])

    # connect_main вызывается дважды: clients (ок) → wb_tokens (падает).
    calls = {"n": 0}

    def main_then_boom():
        calls["n"] += 1
        if calls["n"] >= 2:
            raise psycopg.OperationalError("sid boom")
        return fake_main_ok()

    monkeypatch.setattr("mpu.commands.update.pg.connect_main", main_then_boom)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)

    assert update.fetch_single_client(9) is True

    with store.store(db_path) as conn:
        ss = conn.execute("SELECT ss_id, server FROM sl_spreadsheets").fetchall()
        assert [tuple(r) for r in ss] == [("ss9", "sl-1")]
        assert conn.execute("SELECT sid FROM sl_wb_sids").fetchall() == []


# --- `main` typer command -------------------------------------------------------


def test_main_command_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`mpu update` через CliRunner: exit 0 + печать сводки."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    fake_main, fake_to = _make_fake_pg(
        [(1, "sl-1", True, False, False)],
        {1: [(1, "ss1", "T", None, True)]},
    )
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)
    monkeypatch.setattr("mpu.commands.update.loki_discover.discover_and_store", _quiet_loki)

    runner = CliRunner()
    result = runner.invoke(update.app, [])
    assert result.exit_code == 0
    assert "clients: 1 rows" in result.output


def test_main_command_quiet(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`mpu update --quiet`: exit 0, без сводки."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    with store.store(db_path) as _c:
        store.bootstrap(_c)

    fake_main, fake_to = _make_fake_pg(
        [(1, "sl-1", True, False, False)],
        {1: [(1, "ss1", "T", None, True)]},
    )
    monkeypatch.setattr("mpu.commands.update.pg.connect_main", fake_main)
    monkeypatch.setattr("mpu.commands.update.pg.connect_to", fake_to)
    monkeypatch.setattr("mpu.commands.update.loki_discover.discover_and_store", _quiet_loki)

    runner = CliRunner()
    result = runner.invoke(update.app, ["--quiet"])
    assert result.exit_code == 0
    assert "clients:" not in result.output
