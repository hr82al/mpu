"""`mpu api wb-loader-blocked [--loader X] [--reason Y] [--server wb-N]` —
глобальный список заблокированных wb-loader-app загрузчиков по ВСЕМ серверам.

Зачем: `mpu api wb-loader-resume <selector>` показывает blocked только по sid
одного селектора (всегда шлёт `{filter:{sid}}`). Для обзора «что залочено
вообще, на всех инстансах» нужен вызов без селектора. wb-main уже умеет
агрегировать: `POST /admin/wb-loader/blocked-loaders/v1/find` фан-аутит запрос
на все живые wb-instance и возвращает `{data:[...+server], errors:[{server,error}]}`.
Пустой фильтр `{}` = все блокировки по всем серверам.

API-фильтры (уходят в тело запроса, валидируются Zod-схемой sl-back —
`sid|loader|reason|only_permanent`):
- `--loader <name>` — по загрузчику (`wbAnalytics`, `wbCards`, ...).
- `--reason <reason>` — по причине блокировки (`no_token`, `unknown_error`, ...).
- `--only-permanent` — только permanent-блоки (требующие admin resume).
- `--sid <sid>` — сузить до одного кабинета.

Клиентский фильтр (НЕ часть API — в схеме фильтра sl-back сервера нет; `server`
wb-main добавляет к каждой строке только в агрегированном ответе):
- `--server <wb-N>` — оставить строки только этого инстанса. Фильтрация идёт на
  стороне mpu по `row.server` уже полученного ответа.

`--print` / `-p` — напечатать эквивалентный curl (+ буфер), без выполнения. В
curl попадает только API-`filter` (без `--server`).

Автодополнение: `--loader` / `--reason` — статические списки (зеркало
sl-back-констант). `--server` — из кэша `~/.config/mpu/.wb-loader-servers.json`,
который команда пишет после каждого успешного вызова (имена `wb-N` нигде в mpu
статически не известны — `mpu.lib.servers` знает только `sl-N`). До первого
запуска автодоп. по `--server` пустое.

Для resume залоченного загрузчика — `mpu api wb-loader-resume`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NoReturn

import click

# Переиспользуем стабильные символы из соседней команды (DRY; источник истины
# для path/loader-имён/JSON-guard'ов — там). Cross-module private — осознанно,
# тот же приём, что в tests/test_wb_loader_resume.py.
from mpu.commands.wb_loader_resume import (  # pyright: ignore[reportPrivateUsage]
    _FIND_PATH,  # pyright: ignore[reportPrivateUsage]
    LOADER_NAMES,
    _complete_loader,  # pyright: ignore[reportPrivateUsage]
    _is_obj_list,  # pyright: ignore[reportPrivateUsage]
    _is_str_dict,  # pyright: ignore[reportPrivateUsage]
    _print_json,  # pyright: ignore[reportPrivateUsage]
)
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url, token_cache_path

COMMAND = "mpu api wb-loader-blocked"

# Зеркало BLOCKED_REASONS из
# sl-back/src/wbLoaderInstanceApp/wbLoaderInstanceApp.constants.js:230-243.
# Источник истины — там; здесь нужно для shell-автодополнения и защиты от
# опечатки в `--reason` (sl-back Zod-схема сама отвергнет неизвестное значение,
# но локальная проверка даёт понятную ошибку до сети).
BLOCKED_REASON_NAMES: list[str] = [
    "no_token",
    "cards_not_loaded",
    "cards_filter_not_ready",
    "feature_disabled",
    "endpoint_forbidden",
    "invalid_token",
    "payment_required",
    "response_parse_error",
    "dto_mapping_error",
    "db_write_error",
    "unexpected_http_status",
    "unknown_error",
]


def _fail(reason: str, *, code: int, hint: str | None = None, extra: str | None = None) -> NoReturn:
    """Машинно-читаемая ошибка: `<команда>: <причина>; попробуй: <подсказка>` → exit."""
    msg = f"{COMMAND}: {reason}"
    if hint:
        msg += f"; попробуй: {hint}"
    click.echo(msg, err=True)
    if extra:
        click.echo(extra, err=True)
    raise SystemExit(code)


# ── Кэш имён серверов (для автодополнения `--server`) ────────────────────────


def _servers_cache_path() -> Path:
    """`~/.config/mpu/.wb-loader-servers.json` — рядом с кешем токена (та же
    директория, отдельный файл). Не секрет, права не выставляем."""
    return token_cache_path().parent / ".wb-loader-servers.json"


def _write_servers_cache(names: set[str]) -> None:
    """Atomic write отсортированного JSON-списка. Best-effort — любые OSError
    глушим (кэш автодоп. не критичен для основной операции)."""
    if not names:
        return
    p = _servers_cache_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(sorted(names)), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def _read_servers_cache() -> list[str]:
    """Прочитать кэш серверов. Отсутствует / битый → `[]` (никогда не падает)."""
    p = _servers_cache_path()
    try:
        data: object = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not _is_obj_list(data):
        return []
    return [s for s in data if isinstance(s, str) and s]


def _complete_reason(ctx: click.Context, param: click.Parameter, incomplete: str) -> list[str]:
    """Shell-автодополнение `--reason` по статическому списку причин."""
    _ = ctx, param
    return [n for n in BLOCKED_REASON_NAMES if n.startswith(incomplete)]


def _complete_server(ctx: click.Context, param: click.Parameter, incomplete: str) -> list[str]:
    """Shell-автодополнение `--server` из кэша (без сети). Пусто до первого вызова."""
    _ = ctx, param
    return [n for n in _read_servers_cache() if n.startswith(incomplete)]


# ── Разбор ответа ────────────────────────────────────────────────────────────


def _row_server(row: object) -> str | None:
    """`row.server` если row — dict со строковым `server`, иначе None."""
    if _is_str_dict(row):
        value = row.get("server")
        if isinstance(value, str) and value:
            return value
    return None


def _as_list(value: object, *, what: str) -> list[object]:
    """Ответ-поле должно быть JSON-массивом, иначе exit 1."""
    if _is_obj_list(value):
        return value
    _fail(f"{what}: ожидался JSON-массив, получено {type(value).__name__}", code=1)


# ── curl (--print) ───────────────────────────────────────────────────────────


def _emit_curl(*, base_url: str, filter_: dict[str, object], server: str | None) -> None:
    """Напечатать эквивалентный curl (+ буфер), ничего не выполняя.

    В тело уходит только API-`filter` — `--server` это клиентский пост-фильтр,
    в запрос не входит; о нём печатаем поясняющий комментарий.
    """
    body = json.dumps({"filter": filter_}, ensure_ascii=False)
    lines = [
        "TOKEN=$(mpu api get-token)",
        f'curl -sS -X POST "{base_url}{_FIND_PATH}" '
        '-H "authorization: Bearer $TOKEN" '
        "-H 'content-type: application/json' "
        f"-d '{body}'",
    ]
    if server is not None:
        lines.append(f"# затем клиентский фильтр: .data[] | select(.server == \"{server}\")")
    snippet = "\n".join(lines)
    click.echo(snippet)
    copy_to_clipboard(snippet)


# ── Основная логика ──────────────────────────────────────────────────────────


def _run(
    *,
    loader: str | None,
    reason: str | None,
    only_permanent: bool,
    sid: str | None,
    server: str | None,
    print_mode: bool,
) -> None:
    if loader is not None and loader not in LOADER_NAMES:
        _fail(
            f"неизвестный loader {loader!r}",
            code=2,
            hint=f"один из: {', '.join(LOADER_NAMES)}",
        )
    if reason is not None and reason not in BLOCKED_REASON_NAMES:
        _fail(
            f"неизвестный reason {reason!r}",
            code=2,
            hint=f"один из: {', '.join(BLOCKED_REASON_NAMES)}",
        )

    filter_: dict[str, object] = {}
    if sid:
        filter_["sid"] = sid
    if loader:
        filter_["loader"] = loader
    if reason:
        filter_["reason"] = reason
    if only_permanent:
        filter_["only_permanent"] = True

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            _fail(str(e), code=1)
        _emit_curl(base_url=base_url, filter_=filter_, server=server)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        _fail(str(e), code=1)

    try:
        raw: object = api.request("POST", _FIND_PATH, body={"filter": filter_})
    except SlApiError as e:
        if e.status == 403:
            _fail(
                "find запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_read или выше",
                extra=e.body,
            )
        _fail(f"find не удался: {e}", code=1, extra=e.body)

    if not _is_str_dict(raw):
        _fail(f"find response: ожидался JSON-объект, получено {type(raw).__name__}", code=1)
    data = _as_list(raw.get("data", []), what="find.data")
    errors = _as_list(raw.get("errors", []), what="find.errors")

    # Кэш серверов пишем из ПОЛНОГО ответа (до --server-фильтра), чтобы
    # автодополнение знало все инстансы, а не только отфильтрованный.
    names = {s for r in data if (s := _row_server(r)) is not None}
    names |= {s for e in errors if (s := _row_server(e)) is not None}
    _write_servers_cache(names)

    if server is not None:
        data = [r for r in data if _row_server(r) == server]
        errors = [e for e in errors if _row_server(e) == server]

    server_count = len({s for r in data if (s := _row_server(r)) is not None})
    suffix = f" (filtered by server={server})" if server is not None else ""
    click.echo(
        f"# {len(data)} blocked loader(s) across {server_count} server(s); "
        f"{len(errors)} server error(s){suffix}",
        err=True,
    )
    _print_json({"data": data, "errors": errors})


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    def callback(
        loader: str | None,
        reason: str | None,
        only_permanent: bool,
        sid: str | None,
        server: str | None,
        print_mode: bool,
    ) -> None:
        _run(
            loader=loader,
            reason=reason,
            only_permanent=only_permanent,
            sid=sid,
            server=server,
            print_mode=print_mode,
        )

    params: list[click.Parameter] = [
        click.Option(
            ["--loader"],
            default=None,
            type=str,
            shell_complete=_complete_loader,
            help="API-фильтр по загрузчику (wbAnalytics, wbCards, ...)",
        ),
        click.Option(
            ["--reason"],
            default=None,
            type=str,
            shell_complete=_complete_reason,
            help="API-фильтр по причине блокировки (no_token, unknown_error, ...)",
        ),
        click.Option(
            ["--only-permanent", "only_permanent"],
            is_flag=True,
            default=False,
            help="API-фильтр: только permanent-блоки (требуют admin resume)",
        ),
        click.Option(
            ["--sid"],
            default=None,
            type=str,
            help="API-фильтр: сузить до одного WB sid",
        ),
        click.Option(
            ["--server"],
            default=None,
            type=str,
            shell_complete=_complete_server,
            help="Клиентский фильтр по инстансу (wb-N); НЕ часть API-запроса",
        ),
        click.Option(
            ["--print", "-p", "print_mode"],
            is_flag=True,
            default=False,
            help="Напечатать эквивалентный curl (+ буфер), без выполнения",
        ),
    ]

    return click.Command(
        name="wb-loader-blocked",
        params=params,
        callback=callback,
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
