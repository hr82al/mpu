"""Загрузка переменных окружения из ~/.config/mpu/.env (XDG_CONFIG_HOME).

Файл в репо не используется — секреты хранятся отдельно от кода. .env.example в
корне репо — шаблон для разработчика, реальный .env лежит в `$XDG_CONFIG_HOME/mpu/.env`
(по умолчанию `~/.config/mpu/.env`).
"""

from __future__ import annotations

import contextlib
import os
import re
from pathlib import Path

from dotenv import load_dotenv

_loaded = False


def env_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "mpu" / ".env"


def load() -> None:
    """Загрузить .env один раз за процесс. Идемпотентно."""
    global _loaded
    if _loaded:
        return
    path = env_path()
    if path.exists():
        load_dotenv(path)
    _loaded = True


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


def _format_value(value: str) -> str:
    """Сформировать правую часть `NAME=...` для .env.

    Без кавычек, если значение «простое» (нет пробелов / `#` / кавычек) — так пишутся
    base64-сессии и URL. Иначе — одинарные кавычки (literal, как читает python-dotenv).
    Значение с одинарной кавычкой внутри не поддержано (нам это не нужно) → ValueError.
    """
    if "\n" in value or "\r" in value:
        raise ValueError("env value must not contain newlines")
    if value and not re.search(r"[\s#'\"]", value):
        return value
    if "'" in value:
        raise ValueError("env value with single quote is not supported")
    return f"'{value}'"


def set_persistent(name: str, value: str) -> None:
    """Записать `name=value` в ~/.config/mpu/.env (update-or-append) и в `os.environ`.

    Создаёт файл (0o600) и родительскую директорию при отсутствии, сохраняет прочие
    строки/комментарии. Существующая строка `name=...` (в т.ч. с `export ` / отступом)
    заменяется целиком; иначе — дописывается в конец. Запись атомарная (`.tmp` + replace).
    """
    path = env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    line = f"{name}={_format_value(value)}"

    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(name)}\s*=")
    replaced = False
    out: list[str] = []
    for raw in existing:
        if not replaced and pattern.match(raw):
            out.append(line)
            replaced = True
        else:
            out.append(raw)
    if not replaced:
        out.append(line)

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    tmp.replace(path)
    # 0600 — .env содержит секреты (токены, сессии). replace не гарантирует права.
    with contextlib.suppress(OSError):
        path.chmod(0o600)

    os.environ[name] = value
