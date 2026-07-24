"""`mpu api wb-loader-resume <selector> [loader]` — показать / снять блок
заблокированных wb-loader-app загрузчиков клиента.

Зачем: загрузчики на выделенном wb-loader-app при permanent-ошибке
(`unknown_error`, `db_write_error`, ...) падают в `BLOCKED` и **сами не
восстанавливаются** — нужен admin resume через
`POST /admin/wb-loader/blocked-loaders/resume` (sl-back main проксирует на
wb-loader-app, `operator` подставляется из сессии). Ручной разлок = `mpu api
get-token` + curl; эта команда сворачивает всё в один вызов по `mpu search`
селектору.

Селектор — любой из `mpu search` (client_id / spreadsheet / title / **sid**).
Прямой режим по sid (find/resume идут по sid напрямую, без резолва клиента)
включается если задан явный `--sid` ИЛИ селектор сам — **полный sid**
(UUID-форма). На wb-loader-app загрузчик keyed by sid, а client_id / server —
косметика, причём один кабинет может висеть на нескольких клиентах / разных
серверах (обычный резолв был бы неоднозначен), а кэш `sl_wb_sids` может
отставать — поэтому явному `--sid` доверяем как есть. Иначе sid берётся из
кэша (`mpu search` → `sids`); при нескольких sid для resume нужен
`--sid <sid>`, а SHOW показывает все. Поддерживаются комбинации: только sid /
client_id + sid / только client_id.

Поведение:
- `mpu api wb-loader-resume <selector>` — только ПОКАЗАТЬ, какие sid / какие
  loader заблокированы (find-only, resume НЕ выполняется). Если селектор —
  клиент с несколькими sid, показываются blocked по ВСЕМ его sid.
- `mpu api wb-loader-resume <selector> <loader>` — снять блок с одного загрузчика
  (`loader` — позиционный, с shell-автодополнением имён).
- `mpu api wb-loader-resume <selector> --all` — снять блок со ВСЕХ
  заблокированных загрузчиков sid.
- `--sid <sid>` — явный sid: включает прямой режим, find/resume по этому sid
  напрямую (кэш клиента знать его не обязан).
- `--print` / `-p` — напечатать эквивалентный curl (+ буфер), без выполнения;
  sid резолвится из локального кэша (без сети).

`operator` параметром НЕ передаётся: `injectBlockedLoadersOperator` на sl-back
main перетирает его из сессии (email `TOKEN_EMAIL`). Для resume у `TOKEN_EMAIL`
должна быть роль `support_write` или выше.
"""

from __future__ import annotations

import click

from mpu.commands._wb_loader import (
    LOADER_NAMES,
    LOADER_REFERENCE_HELP,
    as_dict,
    as_list,
    cid_json as _cid_json,
    cid_label as _cid_label,
    cids_for_sid as _cids_for_sid,
    emit_curl,
    looks_like_sid as _looks_like_sid,
    pick_sid as _pick_sid_base,
    print_json as _print_json,
    resolve_sids as _resolve_base,
    sid_from_selector as _sid_from_selector,
    wrong_form_hint as _wrong_form_hint,
)
from mpu.lib.cli_err import bind
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-loader-resume"

# `LOADER_NAMES` (все 25 camelCase-имени) — единый источник в `_wb_loader.LOADERS`.
# blocked-loaders фильтр использует camelCase-имена (НЕ kebab-слаги стандартных
# loader-роутов). Список нужен только для shell-автодополнения и защиты от опечатки
# в позиционном `loader` (sl-back-фильтр сам принял бы любую строку и молча ничего
# не разлочил). Реэкспортируется: `wb_loader_blocked` импортирует `LOADER_NAMES`
# отсюда.

# sl-back main проксирует `/admin/wb-loader/<rest>` → wb-main `/api/<rest>`.
# wb-main aggregation-router слушает именно `/api/blocked-loaders/v1/{find,resume}`
# (см. sl-back/src/wbLoaderMainApp/routers/blockedLoaders.router.js) — `v1` обязателен,
# без него upstream 404.
_FIND_PATH = "/admin/wb-loader/blocked-loaders/v1/find"
_RESUME_PATH = "/admin/wb-loader/blocked-loaders/v1/resume"


def _complete_loader(ctx: click.Context, param: click.Parameter, incomplete: str) -> list[str]:
    """Shell-автодополнение позиционного `loader` по статическому списку имён."""
    _ = ctx, param
    return [n for n in LOADER_NAMES if n.startswith(incomplete)]


_fail = bind(COMMAND)


def _resolve(selector: str, client_id: int | None) -> tuple[int, list[str]]:
    return _resolve_base(selector, client_id, command=COMMAND)


def _pick_sid(selector: str, sids: list[str]) -> str:
    return _pick_sid_base(selector, sids, command=COMMAND)


def _find_blocked(api: SlApi, sid: str) -> list[object]:
    """`POST /blocked-loaders/find` body `{filter:{sid}}` → `data[]`."""
    raw: object = api.request("POST", _FIND_PATH, body={"filter": {"sid": sid}})
    payload = as_dict(raw, what="find response", command=COMMAND)
    return as_list(payload.get("data", []), what="find.data", command=COMMAND)


def _resume(api: SlApi, filter_: dict[str, str]) -> dict[str, object]:
    """`POST /blocked-loaders/resume` body `{filter}` → `{resumed, items}`."""
    try:
        raw: object = api.request("POST", _RESUME_PATH, body={"filter": filter_})
    except SlApiError as e:
        if e.status == 403:  # noqa: PLR2004
            _fail(
                "resume запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        _fail(f"resume не удался: {e}", code=1, extra=e.body)
    return as_dict(raw, what="resume response", command=COMMAND)


def _emit_curl(*, base_url: str, sid: str, loader: str | None, resume_all: bool) -> None:
    """Напечатать эквивалентный curl (+ буфер), ничего не выполняя.

    SHOW-режим (нет loader/`--all`) → curl на `/find`; иначе — на `/resume`.
    """
    if loader or resume_all:
        path = _RESUME_PATH
        filter_: dict[str, str] = {"sid": sid}
        if loader:
            filter_["loader"] = loader
    else:
        path = _FIND_PATH
        filter_ = {"sid": sid}
    emit_curl(base_url=base_url, method="POST", path=path, body={"filter": filter_})


def _run(  # noqa: C901, PLR0912, PLR0915
    *,
    selector: str,
    loader: str | None,
    sid: str | None,
    resume_all: bool,
    client_id: int | None,
    print_mode: bool,
) -> None:
    if resume_all and loader:
        _fail("--all и позиционный loader взаимоисключающи", code=2, hint="оставь что-то одно")
    if loader is not None and loader not in LOADER_NAMES:
        _fail(
            f"неизвестный loader {loader!r}",
            code=2,
            hint=_wrong_form_hint(loader) or f"один из: {', '.join(LOADER_NAMES)}",
        )

    show_mode = not loader and not resume_all

    # Прямой режим по sid: задан явный `--sid` ИЛИ селектор сам — полный sid.
    direct_sid = sid if sid is not None else (selector if _looks_like_sid(selector) else None)
    if direct_sid is not None:
        sid_targets = [direct_sid]
        if client_id is not None:
            cid_json: object = client_id
            cid_human = str(client_id)
        else:
            cids = _cids_for_sid(direct_sid)
            cid_json = _cid_json(cids)
            cid_human = _cid_label(cids)
    else:
        cid, sids = _resolve(selector, client_id)
        cid_json = cid
        cid_human = str(cid)
        if show_mode and len(sids) > 1 and _sid_from_selector(selector, sids) is None:
            # SHOW read-only, клиент с несколькими sid: не требуем один —
            # показываем blocked по всем sid клиента.
            sid_targets = list(sids)
        else:
            sid_targets = [_pick_sid(selector, sids)]

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            _fail(str(e), code=1)
        for s in sid_targets:
            _emit_curl(base_url=base_url, sid=s, loader=loader, resume_all=resume_all)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        _fail(str(e), code=1)

    if show_mode:
        if len(sid_targets) == 1:
            blocked = _find_blocked(api, sid_targets[0])
            click.echo(
                f"# client {cid_human} sid {sid_targets[0]}: {len(blocked)} blocked loader(s)",
                err=True,
            )
            _print_json({"client_id": cid_json, "sid": sid_targets[0], "blocked": blocked})
            return
        per_sid: list[dict[str, object]] = []
        total = 0
        for s in sid_targets:
            blocked = _find_blocked(api, s)
            total += len(blocked)
            per_sid.append({"sid": s, "blocked": blocked})
        click.echo(
            f"# client {cid_human}: {total} blocked loader(s) across {len(sid_targets)} sid",
            err=True,
        )
        _print_json({"client_id": cid_json, "sids": per_sid})
        return

    sid_final = sid_targets[0]
    filter_: dict[str, str] = {"sid": sid_final}
    if loader:
        filter_["loader"] = loader
    result = _resume(api, filter_)
    click.echo(f"# client {cid_human} sid {sid_final}: resumed {result.get('resumed')}", err=True)
    _print_json({"client_id": cid_json, "sid": sid_final, "filter": filter_, "result": result})


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    params: list[click.Parameter] = [
        click.Argument(["selector"], required=True, type=str),
        click.Argument(["loader"], required=False, type=str, shell_complete=_complete_loader),
        click.Option(
            ["--sid"],
            default=None,
            type=str,
            help="Явный WB sid: прямой режим, find/resume по этому sid напрямую",
        ),
        click.Option(
            ["--all", "resume_all"],
            is_flag=True,
            default=False,
            help="Снять блок со всех заблокированных загрузчиков sid",
        ),
        click.Option(
            ["--client-id", "client_id"],
            default=None,
            type=int,
            help="Явный client_id при неоднозначном селекторе",
        ),
        click.Option(
            ["--print", "-p", "print_mode"],
            is_flag=True,
            default=False,
            help="Напечатать эквивалентный curl (+ буфер), без выполнения (sid из кэша)",
        ),
    ]

    return click.Command(
        name="wb-loader-resume",
        params=params,
        callback=_run,
        help=(__doc__ or "") + LOADER_REFERENCE_HELP,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
