"""Тесты `lib/sql_runner.run_sql` через fake psycopg connection."""

import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest

from mpu.lib import pg, servers, sql_runner


class _FakeColumn:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeCursor:
    def __init__(
        self,
        *,
        description: list[_FakeColumn] | None,
        rows: list[tuple[Any, ...]],
        rowcount: int = 0,
    ) -> None:
        self.description = description
        self._rows = rows
        self.rowcount = rowcount
        self.executed_sql: str | None = None

    def execute(self, sql: str) -> None:
        self.executed_sql = sql

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _FakeConn:
    def __init__(self, cur: _FakeCursor) -> None:
        self._cur = cur

    def cursor(self) -> _FakeCursor:
        return self._cur

    def __enter__(self) -> "_FakeConn":
        return self

    def __exit__(self, *_: object) -> None:
        return None


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    env_file = tmp_path / ".env"
    env_file.write_text("pg_1='10.1.0.1'\nPG_PORT='5432'\nPG_DB_NAME='wb'\n")
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()
    yield
    servers.reset_cache()


def test_dry_does_not_connect(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_n: int, **_kw: object) -> _FakeConn:
        raise AssertionError("must not be called in --dry")

    monkeypatch.setattr(pg, "connect_to", boom)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", dry=True, stdout=out, stderr=err)
    assert code == 0
    assert "pg_host: 10.1.0.1" in err.getvalue()
    assert "SELECT 1" in err.getvalue()
    assert out.getvalue() == ""


def test_ddl_no_description_prints_ok(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(description=None, rows=[], rowcount=7)

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "UPDATE t SET x=1", stdout=out, stderr=err)
    assert code == 0
    assert "OK (rowcount=7)" in out.getvalue()
    assert cur.executed_sql == "UPDATE t SET x=1"


def test_select_prints_table(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("id"), _FakeColumn("name")],
        rows=[(1, "alpha"), (2, "beta")],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT id, name FROM t", stdout=out, stderr=err)
    assert code == 0
    text = out.getvalue()
    assert "id" in text and "name" in text
    assert "alpha" in text and "beta" in text
    assert "(2 rows)" in text


def test_select_json(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("id"), _FakeColumn("name")],
        rows=[(1, "alpha")],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", json_out=True, stdout=out, stderr=err)
    assert code == 0
    parsed = json.loads(out.getvalue())
    assert parsed == [{"id": 1, "name": "alpha"}]


def test_select_md(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("id"), _FakeColumn("name")],
        rows=[(1, "alpha"), (2, None)],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", md_out=True, stdout=out, stderr=err)
    assert code == 0
    lines = out.getvalue().splitlines()
    assert lines == [
        "| id | name |",
        "| --- | --- |",
        "| 1 | alpha |",
        "| 2 |  |",
    ]


def test_md_escapes_pipe_and_newline(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("v")],
        rows=[("a|b\nc",)],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", md_out=True, stdout=out, stderr=err)
    assert code == 0
    assert "| a\\|b<br>c |" in out.getvalue()


def test_ddl_json(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(description=None, rows=[], rowcount=3)

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "DELETE FROM t", json_out=True, stdout=out, stderr=err)
    assert code == 0
    parsed = json.loads(out.getvalue())
    assert parsed == {"ok": True, "rowcount": 3}


class _FakeMultiCursor:
    """Курсор, который запоминает все execute() в порядке вызова."""

    def __init__(
        self,
        *,
        description: list[_FakeColumn] | None,
        rows: list[tuple[Any, ...]],
        rowcount: int = 0,
    ) -> None:
        self.description = description
        self._rows = rows
        self.rowcount = rowcount
        self.executed: list[str] = []

    def execute(self, sql: str) -> None:
        self.executed.append(sql)

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def __enter__(self) -> "_FakeMultiCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _FakeMultiConn:
    def __init__(self, cur: _FakeMultiCursor) -> None:
        self._cur = cur

    def cursor(self) -> _FakeMultiCursor:
        return self._cur

    def __enter__(self) -> "_FakeMultiConn":
        return self

    def __exit__(self, *_: object) -> None:
        return None


def test_client_id_sets_search_path(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeMultiCursor(description=None, rows=[], rowcount=1)

    def _fake_connect(_n: int, **_kw: object) -> _FakeMultiConn:
        return _FakeMultiConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(
        1, "SELECT 1", client_id=2190, verbose=True, stdout=out, stderr=err
    )
    assert code == 0
    assert cur.executed[0] == 'SET search_path TO "schema_2190", public'
    assert cur.executed[1] == "SELECT 1"
    assert "search_path: schema_2190, public" in err.getvalue()


def test_meta_hidden_by_default(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("id")],
        rows=[(1,)],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", stdout=out, stderr=err)
    assert code == 0
    assert err.getvalue() == ""
    assert "id" in out.getvalue()


def test_meta_shown_when_verbose(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor(
        description=[_FakeColumn("id")],
        rows=[(1,)],
    )

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", verbose=True, stdout=out, stderr=err)
    assert code == 0
    assert "pg_host: 10.1.0.1" in err.getvalue()
    assert "SELECT 1" in err.getvalue()


def test_no_client_id_skips_search_path(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeMultiCursor(description=None, rows=[], rowcount=1)

    def _fake_connect(_n: int, **_kw: object) -> _FakeMultiConn:
        return _FakeMultiConn(cur)

    monkeypatch.setattr(pg, "connect_to", _fake_connect)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", stdout=out, stderr=err)
    assert code == 0
    assert cur.executed == ["SELECT 1"]
    assert "search_path:" not in err.getvalue()


def test_db_error_returns_1(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def raiser(_n: int, **_kw: object) -> _FakeConn:
        raise psycopg.Error("boom")

    monkeypatch.setattr(pg, "connect_to", raiser)
    out, err = io.StringIO(), io.StringIO()
    code = sql_runner.run_sql(1, "SELECT 1", stdout=out, stderr=err)
    assert code == 1
