"""Loki HTTP client — `/loki/api/v1/query_range` для tail-семантики `mpu logs`.

Без auth (Loki в стенде доступен напрямую по приватной сети). `LOKI_URL` берётся
из `~/.config/mpu/.env` через `servers.env_value`. Если поле не задано — caller
должен сам вернуть `typer.Exit(2)` с понятной ошибкой.
"""

from dataclasses import dataclass

import httpx


@dataclass(frozen=True, slots=True)
class LogEntry:
    ts_ns: int
    line: str
    labels: dict[str, str]


def query_range(
    *,
    base_url: str,
    logql: str,
    start_ns: int,
    end_ns: int,
    limit: int,
    direction: str = "backward",
    timeout: float = 30.0,
) -> list[LogEntry]:
    """`GET {base_url}/loki/api/v1/query_range` → плоский список записей.

    Loki возвращает `result[].values[][ts_ns_string, line]`. Ровняем в плоский
    список `LogEntry`; caller сам сортирует/печатает.

    `direction="backward"` означает "сначала свежие" — нужно для tail-tail. Caller
    обычно потом сортирует ascending для хронологического вывода.
    """
    params = {
        "query": logql,
        "start": str(start_ns),
        "end": str(end_ns),
        "limit": str(limit),
        "direction": direction,
    }
    with httpx.Client(base_url=base_url, timeout=timeout, trust_env=False) as c:
        r = c.get("/loki/api/v1/query_range", params=params)
        r.raise_for_status()
        data = r.json()

    return _parse_query_range_response(data)


def _parse_query_range_response(data: object) -> list[LogEntry]:
    """Извлечь LogEntry из JSON. На любые отклонения схемы — пустой список."""
    # Ленивая граница: pydantic (~150 мс импорта) грузится только при реальном
    # разборе ответа, не при старте CLI (cli.py жадно импортирует все команды).
    from mpu.lib import loki_models

    return loki_models.parse_query_range(data)
