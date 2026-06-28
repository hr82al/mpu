"""Тесты `lib/pg` — проброс read-only опции в psycopg.connect."""

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from mpu.lib import pg, servers


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "pg_1='10.1.0.1'\nPG_PORT='5432'\nPG_DB_NAME='wb'\n"
        "PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n"
        "DEV_PG_USER='u'\nDEV_PG_PASSWORD='p'\n"
    )
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()
    yield
    servers.reset_cache()


def _capture_connect(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_connect(**kw: Any) -> object:
        captured.update(kw)
        return object()

    monkeypatch.setattr(pg.psycopg, "connect", fake_connect)
    return captured


def test_connect_to_read_only_sets_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_to(1, read_only=True)
    assert captured["options"] == "-c default_transaction_read_only=on"


def test_connect_to_default_no_ro_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_to(1)
    # options=None передаётся всегда; psycopg.make_conninfo отбрасывает None-параметры.
    assert captured["options"] is None


def test_connect_dev_read_only_sets_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_dev(read_only=True)
    assert captured["options"] == "-c default_transaction_read_only=on"


@pytest.fixture
def write_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[str], Path]]:
    """Фабрика: записать произвольный `.env`, нацелить на него servers и сбросить кэш."""

    def _write(content: str) -> Path:
        env_file = tmp_path / ".env"
        env_file.write_text(content, encoding="utf-8")
        monkeypatch.setattr(servers, "ENV_PATH", env_file)
        servers.reset_cache()
        return env_file

    yield _write
    servers.reset_cache()


# --- _ro_options (через публичные connect_*) ---------------------------------


def test_connect_dev_default_no_ro_options(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    write_env("DEV_PG_USER='du'\nDEV_PG_PASSWORD='dp'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_dev()
    assert captured["options"] is None


# --- dev_params --------------------------------------------------------------


def test_dev_params_defaults(write_env: Callable[[str], Path]) -> None:
    write_env("")
    assert pg.dev_params() == (pg.DEV_PG_HOST, pg.DEV_PG_PORT, pg.DEV_PG_DB)


def test_dev_params_overrides(write_env: Callable[[str], Path]) -> None:
    write_env("DEV_PG_HOST='10.9.9.9'\nDEV_PG_PORT='6000'\nDEV_PG_DB='other_db'\n")
    assert pg.dev_params() == ("10.9.9.9", "6000", "other_db")


# --- connect_dev: параметры / кредиты ---------------------------------------


def test_connect_dev_default_params(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    write_env("DEV_PG_USER='du'\nDEV_PG_PASSWORD='dp'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_dev()
    assert captured["host"] == pg.DEV_PG_HOST
    assert captured["port"] == int(pg.DEV_PG_PORT)
    assert captured["dbname"] == pg.DEV_PG_DB
    assert captured["user"] == "du"
    assert captured["password"] == "dp"
    assert captured["connect_timeout"] == 10


def test_connect_dev_timeout_passed(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    write_env("DEV_PG_USER='du'\nDEV_PG_PASSWORD='dp'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_dev(timeout=42)
    assert captured["connect_timeout"] == 42


def test_connect_dev_credentials_fallback(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    # DEV_PG_USER/PASSWORD отсутствуют → fallback на PG_MAIN_USER_NAME / PG_PASSWORD.
    write_env("PG_MAIN_USER_NAME='mu'\nPG_PASSWORD='mp'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_dev()
    assert captured["user"] == "mu"
    assert captured["password"] == "mp"


def test_connect_dev_missing_user_raises(write_env: Callable[[str], Path]) -> None:
    write_env("DEV_PG_PASSWORD='dp'\n")
    with pytest.raises(pg.PgConfigError, match="dev PG user"):
        pg.connect_dev()


def test_connect_dev_missing_password_raises(write_env: Callable[[str], Path]) -> None:
    write_env("DEV_PG_USER='du'\n")
    with pytest.raises(pg.PgConfigError, match="dev PG password"):
        pg.connect_dev()


# --- connect_to: параметры / кредиты / резолв хоста --------------------------


def test_connect_to_params(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    write_env(
        "pg_1='10.1.0.1'\nPG_PORT='5433'\nPG_DB_NAME='wbx'\n"
        "PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n"
    )
    captured = _capture_connect(monkeypatch)
    pg.connect_to(1)
    assert captured["host"] == "10.1.0.1"
    assert captured["port"] == 5433
    assert captured["dbname"] == "wbx"
    assert captured["user"] == "u"
    assert captured["password"] == "p"
    assert captured["connect_timeout"] == 10


def test_connect_to_credentials_fallback_and_defaults(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    # PG_PORT/PG_DB_NAME отсутствуют → дефолты; user/password → *_MAIN_* fallback.
    write_env("pg_2='10.2.0.2'\nPG_MAIN_USER_NAME='mu'\nPG_MAIN_USER_PASSWORD='mp'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_to(2)
    assert captured["host"] == "10.2.0.2"
    assert captured["port"] == 5432
    assert captured["dbname"] == "wb"
    assert captured["user"] == "mu"
    assert captured["password"] == "mp"


def test_connect_to_missing_host_raises(write_env: Callable[[str], Path]) -> None:
    write_env("PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n")
    with pytest.raises(pg.PgConfigError, match="PG host"):
        pg.connect_to(7)


def test_connect_to_missing_user_raises(write_env: Callable[[str], Path]) -> None:
    write_env("pg_1='10.1.0.1'\nPG_MY_USER_PASSWORD='p'\n")
    with pytest.raises(pg.PgConfigError, match="PG user"):
        pg.connect_to(1)


def test_connect_to_missing_password_raises(write_env: Callable[[str], Path]) -> None:
    write_env("pg_1='10.1.0.1'\nPG_MY_USER_NAME='u'\n")
    with pytest.raises(pg.PgConfigError, match="PG password"):
        pg.connect_to(1)


# --- instance_conn: PgConn прод-инстанса (источник copy-client) --------------


def test_instance_conn_params(write_env: Callable[[str], Path]) -> None:
    write_env(
        "pg_3='10.3.0.3'\nPG_PORT='5433'\nPG_DB_NAME='wbx'\n"
        "PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n"
    )
    assert pg.instance_conn(3) == pg.PgConn("10.3.0.3", "5433", "wbx", "u", "p")


def test_instance_conn_missing_host_raises(write_env: Callable[[str], Path]) -> None:
    write_env("PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n")
    with pytest.raises(pg.PgConfigError, match="pg_7"):
        pg.instance_conn(7)


def test_connect_main_uses_server_zero(
    write_env: Callable[[str], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    write_env("pg_0='10.0.0.0'\nPG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n")
    captured = _capture_connect(monkeypatch)
    pg.connect_main()
    assert captured["host"] == "10.0.0.0"


# --- PgConn.connect ----------------------------------------------------------


def test_pgconn_connect_passes_params(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    conn = pg.PgConn(host="h", port="6543", dbname="d", user="u", password="p")
    conn.connect(timeout=7)
    assert captured["host"] == "h"
    assert captured["port"] == 6543
    assert captured["dbname"] == "d"
    assert captured["user"] == "u"
    assert captured["password"] == "p"
    assert captured["connect_timeout"] == 7
    # PgConn.connect не пробрасывает read-only options.
    assert "options" not in captured


# --- dev_sl_conn -------------------------------------------------------------


def test_dev_sl_conn(write_env: Callable[[str], Path]) -> None:
    write_env("DEV_PG_USER='du'\nDEV_PG_PASSWORD='dp'\n")
    assert pg.dev_sl_conn() == pg.PgConn(pg.DEV_PG_HOST, pg.DEV_PG_PORT, pg.DEV_PG_DB, "du", "dp")


# --- dev_workspaces_conn -----------------------------------------------------


def test_dev_workspaces_conn_defaults(write_env: Callable[[str], Path]) -> None:
    write_env("DEV_WORKSPACES_USER='wu'\nDEV_WORKSPACES_PASSWORD='wp'\n")
    assert pg.dev_workspaces_conn() == pg.PgConn(
        pg.DEV_WORKSPACES_HOST, pg.DEV_WORKSPACES_PORT, pg.DEV_WORKSPACES_DB, "wu", "wp"
    )


def test_dev_workspaces_conn_overrides(write_env: Callable[[str], Path]) -> None:
    write_env(
        "DEV_WORKSPACES_HOST='1.2.3.4'\nDEV_WORKSPACES_PORT='6000'\n"
        "DEV_WORKSPACES_DB='ws2'\nDEV_WORKSPACES_USER='wu'\nDEV_WORKSPACES_PASSWORD='wp'\n"
    )
    assert pg.dev_workspaces_conn() == pg.PgConn("1.2.3.4", "6000", "ws2", "wu", "wp")


def test_dev_workspaces_conn_missing_creds_raises(
    write_env: Callable[[str], Path],
) -> None:
    write_env("")
    with pytest.raises(pg.PgConfigError, match="dev workspaces creds"):
        pg.dev_workspaces_conn()


# --- local_sl_conn -----------------------------------------------------------


def test_local_sl_conn_defaults(write_env: Callable[[str], Path]) -> None:
    write_env("PG_MAIN_USER_PASSWORD='secret'\n")
    assert pg.local_sl_conn() == pg.PgConn(
        pg.LOCAL_HOST, pg.LOCAL_SL_PORT, pg.LOCAL_SL_DB, "wb_plus_db_admin", "secret"
    )


def test_local_sl_conn_overrides(write_env: Callable[[str], Path]) -> None:
    # password через PG_PASSWORD fallback.
    write_env(
        "PG_LOCAL_PORT='9001'\nPG_DB_NAME='wbz'\nPG_MAIN_USER_NAME='admin'\nPG_PASSWORD='pw'\n"
    )
    assert pg.local_sl_conn() == pg.PgConn(pg.LOCAL_HOST, "9001", "wbz", "admin", "pw")


def test_local_sl_conn_missing_password_raises(
    write_env: Callable[[str], Path],
) -> None:
    write_env("")
    with pytest.raises(pg.PgConfigError, match="local sl password"):
        pg.local_sl_conn()


# --- local_main_conn ---------------------------------------------------------


def test_local_main_conn_defaults(write_env: Callable[[str], Path]) -> None:
    write_env("PG_PASSWORD='pw'\n")
    assert pg.local_main_conn() == pg.PgConn(
        pg.LOCAL_HOST, pg.LOCAL_MAIN_PORT, pg.LOCAL_SL_DB, "wb_plus_db_admin", "pw"
    )


def test_local_main_conn_missing_password_raises(
    write_env: Callable[[str], Path],
) -> None:
    write_env("")
    with pytest.raises(pg.PgConfigError, match="local main password"):
        pg.local_main_conn()


# --- local_workspaces_conn ---------------------------------------------------


def test_local_workspaces_conn_defaults(write_env: Callable[[str], Path]) -> None:
    write_env("")
    assert pg.local_workspaces_conn() == pg.PgConn(
        pg.LOCAL_HOST,
        pg.LOCAL_WORKSPACES_PORT,
        pg.LOCAL_WORKSPACES_DB,
        pg.LOCAL_WORKSPACES_USER,
        "postgres",
    )


def test_local_workspaces_conn_overrides(write_env: Callable[[str], Path]) -> None:
    write_env(
        "LOCAL_WORKSPACES_PORT='7000'\nLOCAL_WORKSPACES_DB='wsx'\n"
        "LOCAL_WORKSPACES_USER='wapp'\nLOCAL_WORKSPACES_PASSWORD='wpass'\n"
    )
    assert pg.local_workspaces_conn() == pg.PgConn(pg.LOCAL_HOST, "7000", "wsx", "wapp", "wpass")
