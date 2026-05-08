"""Резолвер server-name → server-number → IP / Portainer-target.

Источники:
  - `~/.config/mpu/.env` — секреты, ssh-IP, опциональные `sl_<N>_portainer` (legacy).
  - `~/.config/mpu/mpu.db::portainer_containers` — кэш discovery (`mpu init`),
    primary источник Portainer-маппинга.

Lookup-order для Portainer: SQLite first → .env fallback. SQLite кэш можно сбросить
через `mpu init --reset` или `reset_cache()` в тестах.
"""

import re
import sqlite3
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values

from mpu.lib import store as _store

ENV_PATH = Path.home() / ".config" / "mpu" / ".env"


@lru_cache(maxsize=1)
def _env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    return {k: v for k, v in dotenv_values(ENV_PATH).items() if v is not None}


def reset_cache() -> None:
    """Для тестов — сбросить кэш парса .env и SQLite."""
    _env.cache_clear()
    _portainer_db_map.cache_clear()


@lru_cache(maxsize=1)
def _portainer_db_map() -> dict[int, tuple[str, int]]:
    """server_number → (portainer_url, endpoint_id) из SQLite-кэша `mpu init`.

    На любые ошибки (SQLite missing, table missing, schema mismatch) возвращаем `{}`.
    """
    try:
        with _store.store() as conn:
            rows = conn.execute(
                "SELECT server_number, portainer_url, endpoint_id "
                "FROM portainer_containers WHERE server_number IS NOT NULL"
            ).fetchall()
    except sqlite3.Error:
        return {}
    out: dict[int, tuple[str, int]] = {}
    for row in rows:
        n = row["server_number"]
        url = row["portainer_url"]
        eid = row["endpoint_id"]
        if isinstance(n, int) and isinstance(url, str) and isinstance(eid, int):
            out[n] = (url, eid)
    return out


def server_number(name: str | None) -> int | None:
    """`"sl-1"` → `1`, `"sl-0"` → `0`, всё остальное → `None`."""
    if not name:
        return None
    m = re.fullmatch(r"sl-(\d+)", name)
    return int(m.group(1)) if m else None


def sl_ip(n: int) -> str | None:
    return _env().get(f"sl_{n}")


def pg_ip(n: int) -> str | None:
    return _env().get(f"pg_{n}")


def env_value(key: str) -> str | None:
    return _env().get(key)


def list_instance_server_numbers() -> list[int]:
    """Все sl-N (N>0): ssh из `sl_N` ∪ legacy portainer `sl_N_portainer` ∪ SQLite-кэш."""
    out: set[int] = set()
    for key, value in _env().items():
        if not value:
            continue
        m = re.fullmatch(r"sl_(\d+)", key) or re.fullmatch(r"sl_(\d+)_portainer", key)
        if m and (n := int(m.group(1))) > 0:
            out.add(n)
    out.update(_portainer_db_map().keys())
    return sorted(out)


def portainer_target(n: int) -> tuple[str, int] | None:
    """`(base_url, endpoint_id)` для `mp-sl-N-cli`. Lookup-order: SQLite → .env legacy.

    SQLite-источник заполняется через `mpu init` (см. `lib/portainer_discover.py`).
    .env-fallback (`sl_<N>_portainer=<base>/<id>`) поддерживается для обратной
    совместимости — там, где Portainer-маппинг прописан вручную до перехода на init.
    """
    db = _portainer_db_map().get(n)
    if db is not None:
        return db
    raw = _env().get(f"sl_{n}_portainer")
    if not raw:
        return None
    base, _, eid = raw.rpartition("/")
    if not base or not eid.isdigit():
        return None
    return base, int(eid)
