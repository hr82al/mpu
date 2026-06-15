"""Подключение к PG-серверам (main = sl-0, инстансы = sl-1..sl-N).

Кредиты — из `~/.config/mpu/.env` (PG_MY_*).

Отдельный таргет — dev-стенд (`mp_sl_1_dev`, все клиентские схемы в одной БД):
host/port/db захардкожены как дефолты (`DEV_PG_*` override в .env), кредиты —
`PG_MAIN_USER_NAME` + `PG_PASSWORD` (под hr82al dev-PG отклоняет auth).
"""

import psycopg

from mpu.lib import servers

# Dev-стенд: один PG, все клиентские схемы (`schema_<client_id>`) в БД mp_sl_1_dev.
DEV_PG_HOST = "192.168.150.40"
DEV_PG_PORT = "5434"
DEV_PG_DB = "mp_sl_1_dev"


class PgConfigError(RuntimeError):
    pass


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


def connect_dev(*, timeout: int = 10) -> psycopg.Connection:
    """Открыть psycopg-соединение к dev-PG (`mp_sl_1_dev`, все схемы в одной БД)."""
    host, port, dbname = dev_params()
    user, password = _dev_credentials()
    return psycopg.connect(
        host=host,
        port=int(port),
        user=user,
        password=password,
        dbname=dbname,
        connect_timeout=timeout,
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


def connect_to(server_number: int, *, timeout: int = 10) -> psycopg.Connection:
    """Открыть psycopg-соединение к PG сервера `sl-<server_number>`."""
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
    )


def connect_main() -> psycopg.Connection:
    """Открыть psycopg-соединение с main PG (sl-0)."""
    return connect_to(0)
