"""Юнит-тесты `mpu.lib.pg_copy` — ветки, неудобные для прогона через CLI команд."""

from pathlib import Path
from typing import cast

import pytest

from mpu.lib import pg_copy
from mpu.lib.pg import PgConn
from pg_fakes import RichConn


def _execs(conn: RichConn) -> list[str]:
    return [kind for kind, _ in conn.log if kind == "execute"]


def test_grant_client_role_existing_role_only_grants() -> None:
    conn = RichConn("loc", size_row=(1,))  # роль уже есть → без CREATE
    pg_copy.grant_client_role(cast(PgConn, conn), 54)
    assert len(_execs(conn)) == 5  # SELECT роль + 3 GRANT + ALTER ROLE search_path
    assert ("commit", "") in conn.log


def test_grant_client_role_creates_with_password(monkeypatch: pytest.MonkeyPatch) -> None:
    def _ev(key: str) -> str | None:
        return "pw"

    monkeypatch.setattr(pg_copy.servers, "env_value", _ev)
    conn = RichConn("loc", fetchone_seq=[None])  # роли нет → CREATE ROLE ... PASSWORD
    pg_copy.grant_client_role(cast(PgConn, conn), 54)
    assert len(_execs(conn)) == 6  # SELECT + CREATE + 3 GRANT + ALTER ROLE search_path


def test_grant_client_role_creates_without_password(monkeypatch: pytest.MonkeyPatch) -> None:
    def _ev(key: str) -> str | None:
        return None

    monkeypatch.setattr(pg_copy.servers, "env_value", _ev)
    conn = RichConn("loc", fetchone_seq=[None])  # роли нет, пароля нет → CREATE ROLE LOGIN
    pg_copy.grant_client_role(cast(PgConn, conn), 54)
    assert len(_execs(conn)) == 6  # SELECT + CREATE + 3 GRANT + ALTER ROLE search_path


def test_seed_main_clients_cache_writes_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], str]] = []

    def _run(argv: list[str], **kw: object) -> None:
        calls.append((argv, str(kw.get("input"))))

    monkeypatch.setattr(pg_copy.subprocess, "run", _run)
    # row_to_json → psycopg отдаёт распарсенный dict; код сериализует его json.dumps
    conn = RichConn("loc", fetchone_seq=[({"id": 565, "server": "sl-1", "is_active": True},)])
    assert pg_copy.seed_main_clients_cache(cast(PgConn, conn), 565) is True
    assert len(calls) == 1
    argv, payload = calls[0]
    assert argv[:5] == ["docker", "exec", "-i", "mp-sl-0-redis", "redis-cli"]
    assert argv[-2:] == ["SET", "sl-main:clients:565"]
    assert '"server": "sl-1"' in payload  # значение кэша = JSON строки клиента


def test_seed_main_clients_cache_no_client_row(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    def _run(*a: object, **k: object) -> None:
        calls.append(a)

    monkeypatch.setattr(pg_copy.subprocess, "run", _run)
    conn = RichConn("loc", fetchone_seq=[None])  # строки клиента нет
    assert pg_copy.seed_main_clients_cache(cast(PgConn, conn), 999) is False
    assert calls == []  # в Redis ничего не писали


def test_seed_main_clients_cache_redis_error_is_best_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_a: object, **_k: object) -> None:
        raise FileNotFoundError("docker not found")

    monkeypatch.setattr(pg_copy.subprocess, "run", _boom)
    conn = RichConn("loc", fetchone_seq=[({"id": 5, "server": "sl-1"},)])
    assert pg_copy.seed_main_clients_cache(cast(PgConn, conn), 5) is False


def test_schema_size_connect_error_is_best_effort() -> None:
    # RichConn ду-типизирует PgConn; raise_on_connect → ветка except → заглушка.
    conn = cast(PgConn, RichConn("x", raise_on_connect=True))
    assert pg_copy.schema_size(conn, "schema_1") == "размер неизвестен"


def test_schema_exists_true() -> None:
    conn = cast(PgConn, RichConn("x", size_row=(1,)))  # fetchone → truthy
    assert pg_copy.schema_exists(conn, "schema_1") is True


def test_schema_exists_false_when_absent() -> None:
    conn = cast(PgConn, RichConn("x", size_row=None))  # fetchone → None
    assert pg_copy.schema_exists(conn, "schema_1") is False


def test_schema_exists_connect_error_means_false() -> None:
    conn = cast(PgConn, RichConn("x", raise_on_connect=True))  # ветка except
    assert pg_copy.schema_exists(conn, "schema_1") is False


def test_pg_dump_argv_shape() -> None:
    conn = cast(PgConn, RichConn("h"))
    argv = pg_copy.pg_dump_argv(conn, ["-n", "schema_9", "--no-owner"])
    assert argv[0] == "pg_dump"
    assert "-Fc" in argv and "--verbose" in argv  # custom-format + построчный прогресс
    assert argv[-3:] == ["-n", "schema_9", "--no-owner"]  # extra в хвосте
    assert "-h" in argv and "h" in argv  # host из conn


def test_pg_restore_argv_shape() -> None:
    conn = cast(PgConn, RichConn("h"))
    argv = pg_copy.pg_restore_argv(conn, ["--no-owner", "--no-privileges"], Path("/tmp/x.dump"))
    assert argv[0] == "pg_restore"
    assert argv[-1] == "/tmp/x.dump"  # путь дампа последним
    assert "--no-owner" in argv and "--no-privileges" in argv


def test_table_constants_contract() -> None:
    # spreadsheets — родитель листов, поэтому в client-id наборе; токен-набор — его подмножество.
    assert "spreadsheets" in pg_copy.CLIENT_ID_TABLES
    assert set(pg_copy.MAIN_CLIENT_TABLES) <= set(pg_copy.CLIENT_ID_TABLES)
    assert "spreadsheets_sheets_values" in pg_copy.SPREADSHEET_TABLES
