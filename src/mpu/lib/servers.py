"""Резолвер server-name → server-number → IP. Источник: `~/.config/mpu/.env`."""

import re
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values

ENV_PATH = Path.home() / ".config" / "mpu" / ".env"


@lru_cache(maxsize=1)
def _env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    return {k: v for k, v in dotenv_values(ENV_PATH).items() if v is not None}


def reset_cache() -> None:
    """Для тестов — сбросить кэш парса .env."""
    _env.cache_clear()


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
