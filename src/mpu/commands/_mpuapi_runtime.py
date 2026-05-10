"""Runtime для `mpuapi-*` команд.

По спеке из `_mpuapi_spec.COMMANDS` строит для каждого endpoint'а click-команду и
экспортирует `run_<name>()` callable, на которые ссылается
`pyproject.toml#[project.scripts]`.

Парадигма:
  - path placeholders (`:clientId`, `:spreadsheetId`) → позиционные аргументы команды
    в порядке появления в `path`.
  - `body_fields` → опции `--<name> <value>` (типизированные через `field.type`).
  - `accepts_raw_body=True` → дополнительная опция `--body / -b '<json>' | @file.json`,
    при наличии полностью перекрывает `--<field>` опции.
  - `no_auth=True` → запрос без `Authorization` (только `/auth/login`).
  - `token_only=True` → печать только `accessToken` (для `mpuapi-get-token`),
    с автозаполнением email/password из env при отсутствии явных флагов.

Используем `click` напрямую (не `typer.Typer`), потому что typer для команды без
subcommand'ов добавляет лишний `<bin> main ...` шаг — нам же нужен плоский UX.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, NoReturn, cast
from urllib.parse import quote

import click

from mpu.commands._mpuapi_spec import (
    COMMANDS,
    BodyField,
    CommandSpec,
    FieldType,
)
from mpu.lib.slapi import (
    SlApi,
    SlApiError,
    read_token_cache,
    resolve_credentials,
    write_token_cache,
)

# ──────────────────────────────────────────────────────────────────────────────
# Парсинг входных значений
# ──────────────────────────────────────────────────────────────────────────────


def _coerce_value(field_type: FieldType, raw: str, *, field_name: str) -> Any:
    """Преобразовать строку из CLI в нужный JSON-тип."""
    if field_type == "string":
        return raw
    if field_type == "number":
        try:
            if "." in raw or "e" in raw.lower():
                return float(raw)
            return int(raw)
        except ValueError as e:
            raise click.BadParameter(f"--{field_name}: ожидается число, получено '{raw}'") from e
    if field_type == "boolean":
        low = raw.lower()
        if low in ("true", "yes", "1", "on"):
            return True
        if low in ("false", "no", "0", "off"):
            return False
        raise click.BadParameter(
            f"--{field_name}: ожидается boolean (true/false/yes/no/1/0), получено '{raw}'"
        )
    if field_type == "json":
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise click.BadParameter(
                f"--{field_name}: ожидается JSON, получено '{raw[:60]}...': {e.msg}"
            ) from e
    raise AssertionError(f"unknown field_type {field_type!r}")


def _read_body_arg(raw: str) -> Any:
    """`--body` значение: `@path` → читать файл, иначе — JSON-литерал."""
    if raw.startswith("@"):
        path = Path(raw[1:])
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as e:
            raise click.BadParameter(f"--body @{path}: {e}") from e
    else:
        content = raw
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise click.BadParameter(f"--body: невалидный JSON: {e.msg}") from e


def _format_path(spec: CommandSpec, path_values: dict[str, str]) -> str:
    """Подставить path-параметры в `spec.path` с urlquote'ом."""
    out = spec.path
    for param in spec.path_params:
        value = path_values[param.name]
        out = out.replace(":" + param.name, quote(str(value), safe=""))
    return out


def _print_result(value: Any) -> None:
    """JSON pretty-print (UTF-8, без ASCII-escape)."""
    if value is None:
        return
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))


def _is_optional_get_token_field(spec: CommandSpec, field_def: BodyField) -> bool:
    """get-token не требует email/password явно — fallback на env."""
    return spec.token_only and field_def.name in ("email", "password")


def _build_help(spec: CommandSpec) -> str:
    """Многострочная справка: summary + description + параметры."""
    parts: list[str] = [spec.summary]
    if spec.description:
        parts.append("")
        parts.append(spec.description)
    if spec.path_params:
        parts.append("")
        parts.append("Path arguments:")
        for p in spec.path_params:
            parts.append(f"  {p.name}: {p.description}")
    if spec.body_fields:
        parts.append("")
        parts.append("Body fields (use as --<name> <value>):")
        for f in spec.body_fields:
            req = " (required)" if f.required and not _is_optional_get_token_field(spec, f) else ""
            parts.append(f"  --{f.name} ({f.type}){req}: {f.description}")
    if spec.accepts_raw_body:
        parts.append("")
        parts.append("--body / -b: JSON literal или @file.json (перекрывает --<field>)")
    return "\n".join(parts)


# ──────────────────────────────────────────────────────────────────────────────
# Выполнение
# ──────────────────────────────────────────────────────────────────────────────


def _build_body(spec: CommandSpec, kwargs: dict[str, Any]) -> Any:
    """Собрать body из CLI kwargs (либо --body, либо набор --<field>)."""
    body_raw: str | None = kwargs.get("body_raw")
    if spec.accepts_raw_body and body_raw is not None:
        return _read_body_arg(body_raw)

    collected: dict[str, Any] = {}
    for body_field in spec.body_fields:
        raw = kwargs.get(body_field.name)
        if raw is None:
            if body_field.required and not _is_optional_get_token_field(spec, body_field):
                raise click.BadParameter(f"--{body_field.name} обязателен")
            continue
        collected[body_field.name] = _coerce_value(body_field.type, raw, field_name=body_field.name)
    return collected if collected else None


def _execute(spec: CommandSpec, kwargs: dict[str, Any]) -> None:
    path_values = {p.name: kwargs[p.name] for p in spec.path_params}
    body: Any = _build_body(spec, kwargs)

    # get-token: cache-first. При неявных кредах (берутся из env) — отдаём токен из
    # ~/.config/mpu/.api-token.json если он не истёк; только при miss/expired лезем в /auth/login.
    # Явные --email/--password всегда вызывают свежий login и обновляют кеш под нового пользователя.
    if spec.token_only:
        body_dict: dict[str, Any] = cast("dict[str, Any]", body) if isinstance(body, dict) else {}
        explicit_creds = "email" in body_dict and "password" in body_dict
        if not explicit_creds:
            cached = read_token_cache()
            if cached is not None:
                click.echo(cached.token)
                return
            try:
                env_email, env_password = resolve_credentials()
            except SlApiError as e:
                _fail(spec, e)
            body_dict.setdefault("email", env_email)
            body_dict.setdefault("password", env_password)
        body = body_dict

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        _fail(spec, e)

    url_path = _format_path(spec, path_values)
    try:
        result: Any = api.request(spec.method, url_path, body=body, no_auth=spec.no_auth)
    except SlApiError as e:
        _fail(spec, e)

    if spec.token_only:
        if not isinstance(result, dict):
            click.echo(f"mpuapi-{spec.name}: нет accessToken в ответе sl-back", err=True)
            sys.exit(1)
        result_dict = cast("dict[str, Any]", result)
        token = result_dict.get("accessToken")
        if not isinstance(token, str) or not token:
            click.echo(f"mpuapi-{spec.name}: нет accessToken в ответе sl-back", err=True)
            sys.exit(1)
        write_token_cache(token)
        click.echo(token)
        return

    _print_result(result)


def _fail(spec: CommandSpec, error: SlApiError) -> NoReturn:
    """Печать ошибки и `sys.exit(1)`. NoReturn → pyright знает, что код после _fail
    недостижим (поэтому переменные из try-блоков не считаются `possibly unbound`)."""
    click.echo(f"mpuapi-{spec.name}: {error}", err=True)
    if error.body:
        click.echo(error.body, err=True)
    sys.exit(1)


# ──────────────────────────────────────────────────────────────────────────────
# Сборка click.Command для одного endpoint'а
# ──────────────────────────────────────────────────────────────────────────────


def _build_command(spec: CommandSpec) -> click.Command:
    params: list[click.Parameter] = []
    for path_param in spec.path_params:
        params.append(click.Argument([path_param.name], required=True, type=str))
    for body_field in spec.body_fields:
        # Все body-options — str на уровне click; парсинг типов в _coerce_value.
        # Это позволяет boolean писать как `--is_active true` без отдельного флага.
        params.append(
            click.Option(
                [f"--{body_field.name}"],
                required=False,
                default=None,
                type=str,
                help=f"({body_field.type}) {body_field.description}",
            )
        )
    if spec.accepts_raw_body:
        params.append(
            click.Option(
                ["--body", "-b"],
                "body_raw",
                required=False,
                default=None,
                type=str,
                help="полный JSON body: '<json>' или @path/to.json",
            )
        )

    def callback(**kwargs: Any) -> None:
        _execute(spec, kwargs)

    return click.Command(
        name=f"mpuapi-{spec.name}",
        params=params,
        callback=callback,
        help=_build_help(spec),
        context_settings={"help_option_names": ["-h", "--help"]},
    )


def _make_run(spec: CommandSpec) -> Callable[[], None]:
    cmd = _build_command(spec)

    def run() -> None:
        try:
            cmd.main(prog_name=f"mpuapi-{spec.name}", args=sys.argv[1:])
        except SystemExit:
            raise
        except SlApiError as e:
            _fail(spec, e)
        except Exception as e:
            click.echo(f"mpuapi-{spec.name}: unexpected error: {e}", err=True)
            sys.exit(1)

    run.__doc__ = spec.summary
    return run


# ──────────────────────────────────────────────────────────────────────────────
# Авто-генерация run_<name>() для каждой команды.
# `pyproject.toml#[project.scripts]` ссылается на эти имена.
# ──────────────────────────────────────────────────────────────────────────────


def python_name_for(spec_name: str) -> str:
    """`get-token` → `run_get_token`."""
    return "run_" + spec_name.replace("-", "_")


_GENERATED_RUNNERS: dict[str, Callable[[], None]] = {
    python_name_for(spec.name): _make_run(spec) for spec in COMMANDS
}

# Сделать run_* атрибутами модуля, чтобы entry-point'ы могли их импортировать.
globals().update(_GENERATED_RUNNERS)


def list_run_names() -> list[str]:
    """Имена всех `run_*` функций — для self-проверки и генерации pyproject.toml."""
    return sorted(_GENERATED_RUNNERS.keys())


def get_runner(spec_name: str) -> Callable[[], None]:
    """Найти runner по имени спеки (без префикса `mpuapi-`). Бросает KeyError если нет."""
    return _GENERATED_RUNNERS[python_name_for(spec_name)]


# `__all__` намеренно опущен — динамические `run_*` атрибуты не должны попадать
# в статический экспорт-лист (pyright reportUnsupportedDunderAll). Entry-point'ы
# импортируют их по имени через `mpu.commands._mpuapi_runtime:run_<name>`,
# что работает через `globals().update()` выше.
