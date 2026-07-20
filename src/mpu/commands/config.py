"""`mpu config` — просмотр и правка ключей конфигурации в `~/.config/mpu/mpu.db`.

Значения живут в таблице `config` и читаются резолверами (`sheet.default`,
`xlsx.default`) и кэшем листов (`sheet.cache.*`). Реестр ключей ниже —
единственное место, где перечислено, что вообще имеет смысл задавать; дефолты
берутся из модулей-потребителей, чтобы не разъезжаться с ними.

Приоритет при чтении (у числовых ключей кэша): env `MPU_<KEY>` → эта таблица →
дефолт модуля. То есть выставленный здесь ключ перекрывается env-переменной.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Annotated, Literal

import typer

from mpu.lib import env, store
from mpu.lib.cli_err import fail
from mpu.lib.cli_out import print_json
from mpu.lib.sheet_cache import (
    DEFAULT_MAX_TAB_BYTES,
    DEFAULT_MAX_TOTAL_MB,
    DEFAULT_TAB_TTL_SECONDS,
)

COMMAND_NAME = "mpu config"
COMMAND_SUMMARY = "Ключи конфигурации (sheet.default, xlsx.default, кэш листов)"

_HELP = """Show or change mpu configuration. Values are stored in SQLite.

Examples:
  mpu config                                  # list all settings
  mpu config sheet.default                    # show one value
  mpu config sheet.default 1AbC...            # set spreadsheet by default
  mpu config xlsx.default ~/Downloads/r.xlsx  # set .xlsx by default
  mpu config sheet.cache.tab_ttl 3600         # cache tabs for an hour
  mpu config --unset sheet.default            # reset key to default
"""

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=_HELP,
)


@dataclass(frozen=True)
class ConfigKey:
    name: str
    kind: Literal["str", "int"]
    default: str | None
    description: str


# Реестр — источник истины. Дефолты импортируются у потребителей, не дублируются.
KEYS: tuple[ConfigKey, ...] = (
    ConfigKey(
        "sheet.default",
        "str",
        None,
        "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
    ),
    ConfigKey(
        "xlsx.default",
        "str",
        None,
        "Путь или alias .xlsx по умолчанию для `mpu xlsx`",
    ),
    ConfigKey(
        "sheet.cache.tab_ttl",
        "int",
        str(DEFAULT_TAB_TTL_SECONDS),
        "TTL whole-tab кэша листов, секунды",
    ),
    ConfigKey(
        "sheet.cache.max_tab_bytes",
        "int",
        str(DEFAULT_MAX_TAB_BYTES),
        "Порог, выше которого таб не кэшируется, байты (после gzip)",
    ),
    ConfigKey(
        "sheet.cache.max_total_mb",
        "int",
        str(DEFAULT_MAX_TOTAL_MB),
        "Общий потолок кэша листов, МБ",
    ),
)

KEYS_BY_NAME = {k.name: k for k in KEYS}


def _find_key(name: str) -> ConfigKey:
    key = KEYS_BY_NAME.get(name)
    if key is None:
        fail(
            COMMAND_NAME,
            f'unknown config key: "{name}"',
            code=2,
            hint=f"допустимые ключи: {', '.join(KEYS_BY_NAME)}",
        )
    return key


def env_var_for(key: str) -> str:
    """Имя env-переменной, перекрывающей ключ: `sheet.cache.tab_ttl` → `MPU_SHEET_CACHE_TAB_TTL`."""
    return "MPU_" + key.replace(".", "_").upper()


def _stored(conn: sqlite3.Connection, name: str) -> str | None:
    try:
        row = conn.execute("SELECT value FROM config WHERE key = ?", (name,)).fetchone()
    except sqlite3.OperationalError as e:
        fail(COMMAND_NAME, str(e), code=1, hint="mpu init")
    return row["value"] if row is not None else None


@app.command()
def main(
    key: Annotated[
        str | None, typer.Argument(help="Config key (dotted, напр. sheet.default).")
    ] = None,
    value: Annotated[
        str | None, typer.Argument(help="Новое значение (без него — показать).")
    ] = None,
    unset: Annotated[bool, typer.Option("--unset", help="Сбросить ключ к дефолту.")] = False,
    json_out: Annotated[bool, typer.Option("--json", help="Structured JSON.")] = False,
) -> None:
    """Show or change mpu configuration."""
    conn = store.open_store()
    try:
        if key is None:
            if unset:
                fail(COMMAND_NAME, "--unset требует имя ключа", code=2)
            _list(conn, json_out=json_out)
        elif unset:
            _unset(conn, _find_key(key))
        elif value is None:
            _show(conn, _find_key(key), json_out=json_out)
        else:
            _set(conn, _find_key(key), value)
    finally:
        conn.close()


def _effective(conn: sqlite3.Connection, key: ConfigKey) -> tuple[str | None, str]:
    """Действующее значение и его источник: env / config / default."""
    env_value = env.get(env_var_for(key.name))
    if env_value is not None:
        return env_value, "env"
    stored = _stored(conn, key.name)
    if stored is not None:
        return stored, "config"
    return key.default, "default"


def _list(conn: sqlite3.Connection, *, json_out: bool) -> None:
    rows = [(key, *_effective(conn, key)) for key in KEYS]
    if json_out:
        print_json(
            [
                {
                    "key": key.name,
                    "value": value,
                    "source": source,
                    "default": key.default,
                    "description": key.description,
                }
                for key, value, source in rows
            ]
        )
        return
    width = max(len(key.name) for key in KEYS)
    for key, value, source in rows:
        shown = value if value is not None else "(unset)"
        suffix = "" if source == "config" else f"  ({source})"
        typer.echo(f"{key.name.ljust(width)}  {shown}{suffix}")


def _show(conn: sqlite3.Connection, key: ConfigKey, *, json_out: bool) -> None:
    value, source = _effective(conn, key)
    if json_out:
        print_json({"key": key.name, "value": value, "source": source, "default": key.default})
        return
    if value is not None:
        typer.echo(value)


def _set(conn: sqlite3.Connection, key: ConfigKey, value: str) -> None:
    if key.kind == "int":
        try:
            int(value)
        except ValueError:
            fail(
                COMMAND_NAME,
                f'{key.name} ожидает целое число, получено "{value}"',
                code=2,
            )
    try:
        conn.execute(
            "INSERT INTO config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key.name, value),
        )
        conn.commit()
    except sqlite3.OperationalError as e:
        fail(COMMAND_NAME, str(e), code=1, hint="mpu init")
    typer.echo(f"{key.name} = {value}")
    env_value = env.get(env_var_for(key.name))
    if env_value is not None:
        typer.echo(
            f"внимание: {env_var_for(key.name)}={env_value} в окружении перекрывает это значение",
            err=True,
        )


def _unset(conn: sqlite3.Connection, key: ConfigKey) -> None:
    try:
        conn.execute("DELETE FROM config WHERE key = ?", (key.name,))
        conn.commit()
    except sqlite3.OperationalError as e:
        fail(COMMAND_NAME, str(e), code=1, hint="mpu init")
    shown = key.default if key.default is not None else "(unset)"
    typer.echo(f"{key.name} сброшен к дефолту: {shown}")
