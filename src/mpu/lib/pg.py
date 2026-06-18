"""Подключение к PG-серверам (main = sl-0, инстансы = sl-1..sl-N).

Кредиты — из `~/.config/mpu/.env` (PG_MY_*).

Отдельный таргет — dev-стенд (`mp_sl_1_dev`, все клиентские схемы в одной БД):
host/port/db захардкожены как дефолты (`DEV_PG_*` override в .env), кредиты —
`PG_MAIN_USER_NAME` + `PG_PASSWORD` (под hr82al dev-PG отклоняет auth).
"""

from typing import NamedTuple

import psycopg

from mpu.lib import servers

# Dev-стенд: один PG, все клиентские схемы (`schema_<client_id>`) в БД mp_sl_1_dev.
DEV_PG_HOST = "192.168.150.40"
DEV_PG_PORT = "5434"
DEV_PG_DB = "mp_sl_1_dev"

# Dev sw-back (workspaces): отдельный PG (multi-tenant по `workspace.id`).
DEV_WORKSPACES_HOST = "192.168.150.41"
DEV_WORKSPACES_PORT = "5432"
DEV_WORKSPACES_DB = "workspaces"

# Локальный docker-стек: sl-0/main (`mp-sl-0-pg`), sl-1 (`mp-sl-1-pg`), оба БД `wb`;
# sw-back (`mp-sw-pg`, `workspaces`).
LOCAL_HOST = "127.0.0.1"
LOCAL_MAIN_PORT = "5440"
LOCAL_SL_PORT = "5441"
LOCAL_SL_DB = "wb"
LOCAL_WORKSPACES_PORT = "5451"
LOCAL_WORKSPACES_DB = "workspaces"
LOCAL_WORKSPACES_USER = "workspacesapp"


class PgConfigError(RuntimeError):
    pass


# libpq-опция для read-only сессии: любой INSERT/UPDATE/DELETE/DDL отклоняется
# Postgres'ом (SQLSTATE 25006). Сильнее, чем разовый `SET TRANSACTION READ ONLY`:
# применяется ко всем implicit-транзакциям сессии. Используется `mpu sql-ro`.
# psycopg.make_conninfo отбрасывает kwargs со значением None, поэтому при
# read_only=False опция не попадает в строку подключения.
_RO_OPTIONS = "-c default_transaction_read_only=on"


def _ro_options(read_only: bool) -> str | None:
    return _RO_OPTIONS if read_only else None


def dev_params() -> tuple[str, str, str]:
    """`(host, port, dbname)` dev-PG. Дефолты захардкожены, override через `DEV_PG_*`."""
    host = servers.env_value("DEV_PG_HOST") or DEV_PG_HOST
    port = servers.env_value("DEV_PG_PORT") or DEV_PG_PORT
    dbname = servers.env_value("DEV_PG_DB") or DEV_PG_DB
    return host, port, dbname


def _dev_credentials() -> tuple[str, str]:
    user = servers.env_value("DEV_PG_USER") or servers.env_value("PG_MAIN_USER_NAME")
    if not user:
        raise PgConfigError(
            "dev PG user: не задано DEV_PG_USER/PG_MAIN_USER_NAME в ~/.config/mpu/.env"
        )
    password = servers.env_value("DEV_PG_PASSWORD") or servers.env_value("PG_PASSWORD")
    if not password:
        raise PgConfigError("dev PG password: не задано DEV_PG_PASSWORD/PG_PASSWORD")
    return user, password


def connect_dev(*, timeout: int = 10, read_only: bool = False) -> psycopg.Connection:
    """Открыть psycopg-соединение к dev-PG (`mp_sl_1_dev`, все схемы в одной БД).

    :param timeout: connect_timeout в секундах.
    :param read_only: при True сессия открывается с `default_transaction_read_only=on`
        — запись отклоняется Postgres'ом (SQLSTATE 25006). Для `mpu sql-ro`.
    """
    host, port, dbname = dev_params()
    user, password = _dev_credentials()
    return psycopg.connect(
        host=host,
        port=int(port),
        user=user,
        password=password,
        dbname=dbname,
        connect_timeout=timeout,
        options=_ro_options(read_only),
    )


def _credentials() -> tuple[str, str, str, str]:
    port = servers.env_value("PG_PORT") or "5432"
    user = servers.env_value("PG_MY_USER_NAME") or servers.env_value("PG_MAIN_USER_NAME")
    if not user:
        raise PgConfigError(
            "PG user: не задано PG_MY_USER_NAME/PG_MAIN_USER_NAME в ~/.config/mpu/.env"
        )
    password = servers.env_value("PG_MY_USER_PASSWORD") or servers.env_value(
        "PG_MAIN_USER_PASSWORD"
    )
    if not password:
        raise PgConfigError("PG password: не задано PG_MY_USER_PASSWORD/PG_MAIN_USER_PASSWORD")
    dbname = servers.env_value("PG_DB_NAME") or "wb"
    return port, user, password, dbname


def connect_to(
    server_number: int, *, timeout: int = 10, read_only: bool = False
) -> psycopg.Connection:
    """Открыть psycopg-соединение к PG сервера `sl-<server_number>`.

    :param timeout: connect_timeout в секундах.
    :param read_only: при True сессия открывается с `default_transaction_read_only=on`
        — запись отклоняется Postgres'ом (SQLSTATE 25006). Для `mpu sql-ro`.
    """
    host = servers.pg_ip(server_number)
    if not host:
        raise PgConfigError(f"PG host: не найдено pg_{server_number} в ~/.config/mpu/.env")
    port, user, password, dbname = _credentials()
    return psycopg.connect(
        host=host,
        port=int(port),
        user=user,
        password=password,
        dbname=dbname,
        connect_timeout=timeout,
        options=_ro_options(read_only),
    )


def connect_main() -> psycopg.Connection:
    """Открыть psycopg-соединение с main PG (sl-0)."""
    return connect_to(0)


class PgConn(NamedTuple):
    """Параметры подключения к PG — для shell-out (`pg_dump`/`pg_restore`/`psql`) и psycopg.

    `mpu copy-dev` копирует данные `pg_dump`/`pg_restore` (dt-host тут не подходит — dev на
    отдельном сервере), поэтому нужны именно параметры, а не открытое соединение.
    """

    host: str
    port: str
    dbname: str
    user: str
    password: str

    def connect(self, *, timeout: int = 10) -> psycopg.Connection:
        return psycopg.connect(
            host=self.host,
            port=int(self.port),
            user=self.user,
            password=self.password,
            dbname=self.dbname,
            connect_timeout=timeout,
        )


def dev_sl_conn() -> PgConn:
    """Dev sl-PG (`mp_sl_1_dev`, все схемы `schema_<id>` + public). Источник для `copy-dev <id>`."""
    host, port, dbname = dev_params()
    user, password = _dev_credentials()
    return PgConn(host, port, dbname, user, password)


def dev_workspaces_conn() -> PgConn:
    """Dev sw-back PG (БД `workspaces`). Источник для `copy-dev` (без аргумента).

    Кредиты не угадываем — `DEV_WORKSPACES_USER`/`DEV_WORKSPACES_PASSWORD` в `~/.config/mpu/.env`.
    """
    host = servers.env_value("DEV_WORKSPACES_HOST") or DEV_WORKSPACES_HOST
    port = servers.env_value("DEV_WORKSPACES_PORT") or DEV_WORKSPACES_PORT
    dbname = servers.env_value("DEV_WORKSPACES_DB") or DEV_WORKSPACES_DB
    user = servers.env_value("DEV_WORKSPACES_USER")
    password = servers.env_value("DEV_WORKSPACES_PASSWORD")
    if not user or not password:
        raise PgConfigError(
            "dev workspaces creds: задайте DEV_WORKSPACES_USER/DEV_WORKSPACES_PASSWORD "
            "в ~/.config/mpu/.env"
        )
    return PgConn(host, port, dbname, user, password)


def local_sl_conn() -> PgConn:
    """Локальный sl-1 PG (`mp-sl-1-pg`, БД `wb`). Таргет схемы+public-строк для `copy-dev <id>`."""
    port = servers.env_value("PG_LOCAL_PORT") or LOCAL_SL_PORT
    dbname = servers.env_value("PG_DB_NAME") or LOCAL_SL_DB
    user = servers.env_value("PG_MAIN_USER_NAME") or "wb_plus_db_admin"
    password = servers.env_value("PG_MAIN_USER_PASSWORD") or servers.env_value("PG_PASSWORD")
    if not password:
        raise PgConfigError("local sl password: не задано PG_MAIN_USER_PASSWORD/PG_PASSWORD")
    return PgConn(LOCAL_HOST, port, dbname, user, password)


def local_main_conn() -> PgConn:
    """Локальный sl-0/main PG (`mp-sl-0-pg`, БД `wb`). Таргет токен-строк для `copy-dev <id>`:
    `clients`/`wb_tokens`/`clients_wb_cabinets` — authoritative store на main, оттуда читает
    wb-cabinet/clientsWbTokens (instance — read-only реплика)."""
    port = servers.env_value("PG_LOCAL_MAIN_PORT") or LOCAL_MAIN_PORT
    dbname = servers.env_value("PG_DB_NAME") or LOCAL_SL_DB
    user = servers.env_value("PG_MAIN_USER_NAME") or "wb_plus_db_admin"
    password = servers.env_value("PG_MAIN_USER_PASSWORD") or servers.env_value("PG_PASSWORD")
    if not password:
        raise PgConfigError("local main password: не задано PG_MAIN_USER_PASSWORD/PG_PASSWORD")
    return PgConn(LOCAL_HOST, port, dbname, user, password)


def local_workspaces_conn() -> PgConn:
    """Локальный sw-back PG (`mp-sw-pg`, БД `workspaces`). Таргет для `copy-dev` (без аргумента)."""
    port = servers.env_value("LOCAL_WORKSPACES_PORT") or LOCAL_WORKSPACES_PORT
    dbname = servers.env_value("LOCAL_WORKSPACES_DB") or LOCAL_WORKSPACES_DB
    user = servers.env_value("LOCAL_WORKSPACES_USER") or LOCAL_WORKSPACES_USER
    password = servers.env_value("LOCAL_WORKSPACES_PASSWORD") or "postgres"
    return PgConn(LOCAL_HOST, port, dbname, user, password)
