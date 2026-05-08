"""Загрузка переменных окружения из ~/.config/mpu/.env (XDG_CONFIG_HOME).

Файл в репо не используется — секреты хранятся отдельно от кода. .env.example в
корне репо — шаблон для разработчика, реальный .env лежит в `$XDG_CONFIG_HOME/mpu/.env`
(по умолчанию `~/.config/mpu/.env`).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_LOADED = False


def env_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "mpu" / ".env"


def load() -> None:
    """Загрузить .env один раз за процесс. Идемпотентно."""
    global _LOADED
    if _LOADED:
        return
    path = env_path()
    if path.exists():
        load_dotenv(path)
    _LOADED = True


def require(name: str) -> str:
    """Вернуть переменную или бросить понятное исключение, указав, где её ждали."""
    load()
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(
            f"environment variable {name} is not set. "
            f"Add it to {env_path()} or export in shell.\n"
            f"See {Path(__file__).parents[3] / '.env.example'} for the template."
        )
    return val


def get(name: str, default: str | None = None) -> str | None:
    load()
    return os.environ.get(name, default)
