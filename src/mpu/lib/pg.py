"""Подключение к PG-серверам (main = sl-0, инстансы = sl-1..sl-N).

Кредиты — из `~/.config/mpu/.env` (PG_MY_*).
"""

import psycopg

from mpu.lib import servers


class PgConfigError(RuntimeError):
    pass


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
