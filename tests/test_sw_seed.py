"""Юнит-тесты `mpu.lib.sw_seed` — проводка входа в локальный sw-front."""

from typing import cast

import pytest

from mpu.lib import sw_seed
from mpu.lib.pg import PgConn
from pg_fakes import RichConn


def test_login_email() -> None:
    assert sw_seed.login_email(1084) == "client_1084@local.host"


def test_read_client_cabinets_enriches_and_defaults() -> None:
    # (sid, name, trade_mark): первый — с именем, второй — пустые → дефолты от client_id.
    conn = cast(PgConn, RichConn("sl", ss_rows=[("sid-1", "ИП Иванов", "TM"), ("sid-2", "", "")]))
    cabinets = sw_seed.read_client_cabinets(conn, 5)
    assert cabinets == [("sid-1", "ИП Иванов", "TM"), ("sid-2", "client 5", "client 5")]


def test_read_client_cabinets_empty() -> None:
    conn = cast(PgConn, RichConn("sl", ss_rows=[]))
    assert sw_seed.read_client_cabinets(conn, 5) == []


def test_seed_login_workspace_returns_email_and_commits() -> None:
    conn = RichConn("sw", size_row=(7,))  # users-upsert RETURNING id → 7
    email = sw_seed.seed_login_workspace(cast(PgConn, conn), 5, [("sid-1", "Cab", "TM")])
    assert email == "client_5@local.host"
    assert ("commit", "") in conn.log  # транзакция закоммичена
    # user + workspace + (cabinet + link + subscription) = 5 INSERT-ов
    assert sum(1 for kind, _ in conn.log if kind == "execute") == 5


def test_seed_login_workspace_no_id_raises() -> None:
    conn = cast(PgConn, RichConn("sw", size_row=None))  # RETURNING id → None
    with pytest.raises(RuntimeError, match="не вернул id"):
        sw_seed.seed_login_workspace(conn, 5, [])


def test_flush_sw_redis_invokes_docker(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def _run(argv: list[str], **_: object) -> None:
        calls.append(argv)

    monkeypatch.setattr(sw_seed.subprocess, "run", _run)
    sw_seed.flush_sw_redis()
    assert calls and calls[0][:3] == ["docker", "exec", "redis-dev"]
    assert "FLUSHALL" in calls[0]


def test_flush_sw_redis_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(argv: list[str], **_: object) -> None:
        raise FileNotFoundError("no docker")

    monkeypatch.setattr(sw_seed.subprocess, "run", _boom)
    sw_seed.flush_sw_redis()  # не бросает — best-effort
