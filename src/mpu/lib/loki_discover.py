"""Discover hosts/services из Loki в `~/.config/mpu/mpu.db` для shell completion.

Источник — Loki series API (`/loki/api/v1/series`) с матчером `{host=~".+"}` за
последние сутки: возвращает уникальные комбинации stream-меток. Извлекаем пары
`(host, compose_service)`, складываем в `loki_hosts` / `loki_services_by_host`.

Идемпотентно: при `discover_and_store(...)` — DELETE+INSERT в одной транзакции.
Best-effort: если `LOKI_URL` не задан или Loki недоступен — возвращает `(0, 0)`,
не бросает. Вызывается из `mpu init` и `mpu-update`.
"""

import time
from dataclasses import dataclass
from typing import cast

import httpx

from mpu.lib import servers, store


@dataclass(frozen=True, slots=True)
class DiscoveryResult:
    hosts: list[str]
    services_by_host: dict[str, list[str]]
    error: str | None = None


def discover_and_store(*, lookback_seconds: int = 86400, timeout: float = 10.0) -> DiscoveryResult:
    """Запросить Loki, записать в SQLite. Идемпотентно (DELETE+INSERT)."""
    base_url = servers.env_value("LOKI_URL")
    if not base_url:
        return DiscoveryResult(hosts=[], services_by_host={}, error="LOKI_URL не задан")

    try:
        result = _discover(base_url, lookback_seconds=lookback_seconds, timeout=timeout)
    except httpx.HTTPError as e:
        return DiscoveryResult(hosts=[], services_by_host={}, error=f"loki: {e}")

    discovered_at = int(time.time())
    with store.store() as conn, conn:
        conn.execute("DELETE FROM loki_hosts")
        conn.executemany(
            "INSERT INTO loki_hosts (host, discovered_at) VALUES (?, ?)",
            [(h, discovered_at) for h in result.hosts],
        )
        conn.execute("DELETE FROM loki_services_by_host")
        rows: list[tuple[str, str, int]] = []
        for host, services in result.services_by_host.items():
            for service in services:
                rows.append((host, service, discovered_at))
        conn.executemany(
            "INSERT INTO loki_services_by_host (host, service, discovered_at) VALUES (?, ?, ?)",
            rows,
        )

    return result


def _discover(base_url: str, *, lookback_seconds: int, timeout: float) -> DiscoveryResult:
    """`/loki/api/v1/series?match[]={host=~".+"}` → unique (host, compose_service) тuples."""
    end_ns = int(time.time() * 1_000_000_000)
    start_ns = end_ns - lookback_seconds * 1_000_000_000
    params: dict[str, str] = {
        "match[]": '{host=~".+"}',
        "start": str(start_ns),
        "end": str(end_ns),
    }
    with httpx.Client(base_url=base_url, timeout=timeout, trust_env=False) as c:
        r = c.get("/loki/api/v1/series", params=params)
        r.raise_for_status()
        data = r.json()

    if not isinstance(data, dict):
        return DiscoveryResult(hosts=[], services_by_host={})
    series = cast(dict[str, object], data).get("data")
    if not isinstance(series, list):
        return DiscoveryResult(hosts=[], services_by_host={})

    hosts: set[str] = set()
    services_by_host: dict[str, set[str]] = {}
    for entry in cast(list[object], series):
        if not isinstance(entry, dict):
            continue
        labels = cast(dict[str, object], entry)
        host = labels.get("host")
        service = labels.get("compose_service")
        if not isinstance(host, str):
            continue
        hosts.add(host)
        if isinstance(service, str):
            services_by_host.setdefault(host, set()).add(service)

    return DiscoveryResult(
        hosts=sorted(hosts),
        services_by_host={h: sorted(s) for h, s in services_by_host.items()},
    )
