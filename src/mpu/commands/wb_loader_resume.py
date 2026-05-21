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

import json
import re
from typing import NoReturn, TypeGuard

import click

from mpu.lib.cli_wrap import auto_pick_int
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-loader-resume"

# Зеркало WB_*_LOADER из
# sl-back/src/wbLoaderInstanceApp/wbLoaderInstanceApp.constants.js:142-152.
# Источник истины — там; здесь список нужен только для shell-автодополнения и
# защиты от опечатки в позиционном `loader` (sl-back-фильтр сам по себе принял
# бы любую строку и молча ничего не разлочил).
LOADER_NAMES: list[str] = [
    "wbAnalytics",
    "wbCards",
    "wbOrders",
    "wbSales",
    "wbReports",
    "wbFeedbacks",
    "wbAdvertsDetailed",
    "wbSearchTexts",
    "wbSupplies",
    "wbAnalyticsStocks",
    "wbAcceptanceReports",
]

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


def _fail(reason: str, *, code: int, hint: str | None = None, extra: str | None = None) -> NoReturn:
    """Машинно-читаемая ошибка: `<команда>: <причина>; попробуй: <подсказка>` → exit."""
    msg = f"{COMMAND}: {reason}"
    if hint:
        msg += f"; попробуй: {hint}"
    click.echo(msg, err=True)
    if extra:
        click.echo(extra, err=True)
    raise SystemExit(code)


def _print_json(value: object) -> None:
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))


# Явные TypeGuard'ы для границы JSON-ответа (CLAUDE.md §5 — type-guard, не cast/Any).
# Используем positive-narrowing (`if guard: ...` + `_fail()` NoReturn в else),
# т.к. plain TypeGuard не даёт negative-narrowing, а TypeIs нет в py3.12 stdlib.
def _is_obj_list(o: object) -> TypeGuard[list[object]]:
    return isinstance(o, list)


def _is_str_dict(o: object) -> TypeGuard[dict[str, object]]:
    return isinstance(o, dict)


def _as_list(value: object, *, what: str) -> list[object]:
    """Ответ должен быть JSON-массивом, иначе exit 1."""
    if _is_obj_list(value):
        return value
    _fail(f"{what}: ожидался JSON-массив, получено {type(value).__name__}", code=1)


def _as_dict(value: object, *, what: str) -> dict[str, object]:
    """Ответ должен быть JSON-объектом, иначе exit 1."""
    if _is_str_dict(value):
        return value
    _fail(f"{what}: ожидался JSON-объект, получено {type(value).__name__}", code=1)


def _find_blocked(api: SlApi, sid: str) -> list[object]:
    """`POST /blocked-loaders/find` body `{filter:{sid}}` → `data[]`."""
    raw: object = api.request("POST", _FIND_PATH, body={"filter": {"sid": sid}})
    payload = _as_dict(raw, what="find response")
    return _as_list(payload.get("data", []), what="find.data")


def _resume(api: SlApi, filter_: dict[str, str]) -> dict[str, object]:
    """`POST /blocked-loaders/resume` body `{filter}` → `{resumed, items}`."""
    try:
        raw: object = api.request("POST", _RESUME_PATH, body={"filter": filter_})
    except SlApiError as e:
        if e.status == 403:
            _fail(
                "resume запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        _fail(f"resume не удался: {e}", code=1, extra=e.body)
    return _as_dict(raw, what="resume response")


def _emit_curl(*, base_url: str, sid: str, loader: str | None, resume_all: bool) -> None:
    """Напечатать эквивалентный curl (+ буфер), ничего не выполняя.

    SHOW-режим (нет loader/`--all`) → curl на `/find`; иначе — на `/resume`.
    Токен НЕ кладём в команду напрямую — через `$(mpu api get-token)`, чтобы он
    не утёк в буфер/историю.
    """
    if loader or resume_all:
        path, filter_ = _RESUME_PATH, {"sid": sid}
        if loader:
            filter_["loader"] = loader
    else:
        path, filter_ = _FIND_PATH, {"sid": sid}
    body = json.dumps({"filter": filter_}, ensure_ascii=False)
    snippet = (
        "TOKEN=$(mpu api get-token)\n"
        f'curl -sS -X POST "{base_url}{path}" '
        '-H "authorization: Bearer $TOKEN" '
        "-H 'content-type: application/json' "
        f"-d '{body}'"
    )
    click.echo(snippet)
    copy_to_clipboard(snippet)


def _resolve(selector: str, client_id: int | None) -> tuple[int, list[str]]:
    """Селектор → `(client_id, sids)` из локального кэша (`mpu search`).

    `--client-id` переопределяет выбор клиента среди кандидатов (как в
    `data_loader.py`), но резолв всё равно выполняется — чтобы достать
    кэшированные `sids` без сетевого вызова.
    """
    try:
        _server, candidates = resolve_server(selector)
    except ResolveError as e:
        _fail(
            str(e),
            code=2,
            hint="уточни селектор или передай --client-id <id>",
            extra=format_candidates(e.candidates) if e.candidates else None,
        )
    cid = client_id if client_id is not None else auto_pick_int(candidates, "client_id")
    if cid is None:
        _fail(
            f"не удалось однозначно определить client_id из {selector!r}",
            code=2,
            hint="передай --client-id <id> (или селектор клиента, не sl-N)",
            extra=format_candidates(candidates) if candidates else None,
        )
    sids: list[str] = []
    for cand in candidates:
        if cand.get("client_id") != cid:
            continue
        raw = cand.get("sids")
        if _is_obj_list(raw):
            for s in raw:
                if isinstance(s, str) and s and s not in sids:
                    sids.append(s)
    return cid, sids


# UUID-форма WB sid (8-4-4-4-12 hex). Полный sid → find/resume идут по sid
# напрямую (см. `_looks_like_sid`).
_SID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _looks_like_sid(value: str) -> bool:
    """`value` — полный WB sid (UUID-форма).

    Тогда find/resume идут по sid напрямую: на wb-loader-app загрузчик keyed
    by sid (schema-per-sid), а client_id / server — косметика. Резолв клиента
    не нужен и может быть неоднозначным (один кабинет висит на нескольких
    клиентах / разных серверах) — это не должно блокировать показ/разлок.
    """
    return bool(_SID_RE.match(value))


def _cids_for_sid(sid: str) -> list[int]:
    """client_id(ы) этого sid из локального кэша — только для лейбла вывода.

    Никогда не падает: на wb-loader-app sid однозначен, даже если в нашем
    кэше он висит на нескольких клиентах / серверах. Пустой кэш → `[]`.
    """
    try:
        _n, cands = resolve_server(sid)
    except ResolveError as e:
        cands = e.candidates
    return sorted({c for x in cands if isinstance(c := x.get("client_id"), int)})


def _cid_json(cids: list[int]) -> object:
    """`client_id` для JSON: int если однозначен, список если несколько, иначе null."""
    if len(cids) == 1:
        return cids[0]
    return cids or None


def _cid_label(cids: list[int]) -> str:
    """`client_id` для человекочитаемой stderr-строки."""
    return ",".join(str(c) for c in cids) if cids else "?"


def _sid_from_selector(selector: str, sids: list[str]) -> str | None:
    """sid, явно названный самим селектором: точное совпадение или
    однозначный substring среди `sids` клиента. Иначе `None`."""
    exact = [s for s in sids if s == selector]
    if len(exact) == 1:
        return exact[0]
    substr = [s for s in sids if selector and selector in s]
    if not exact and len(substr) == 1:
        return substr[0]
    return None


def _pick_sid(selector: str, sids: list[str]) -> str:
    """Выбрать sid: sid из селектора > единственный > exit 2.

    Вызывается только когда явного `--sid` нет и селектор — не полный sid:
    в этих случаях работаем по sid напрямую (см. `_run`), резолв клиента не
    нужен.
    """
    named = _sid_from_selector(selector, sids)
    if named is not None:
        return named
    if len(sids) == 1:
        return sids[0]
    if not sids:
        _fail(
            "не удалось определить sid клиента (кэш пуст?)",
            code=2,
            hint="укажи --sid <sid> или обнови кэш: mpu update",
        )
    _fail(
        f"у клиента несколько WB sid ({len(sids)})",
        code=2,
        hint="укажи --sid <sid>",
        extra="\n".join(f"  --sid {s}" for s in sids),
    )


def _run(
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
            hint=f"один из: {', '.join(LOADER_NAMES)}",
        )

    show_mode = not loader and not resume_all

    # Прямой режим по sid: задан явный `--sid` ИЛИ селектор сам — полный sid.
    # Тогда find/resume идут по sid напрямую, без резолва клиента: на
    # wb-loader-app загрузчик keyed by sid, а резолв может быть неоднозначным
    # (общий кабинет у нескольких клиентов / на разных серверах) либо кэш
    # `sl_wb_sids` отстаёт. client_id — best-effort только для лейбла.
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

    def callback(
        selector: str,
        loader: str | None,
        sid: str | None,
        resume_all: bool,
        client_id: int | None,
        print_mode: bool,
    ) -> None:
        _run(
            selector=selector,
            loader=loader,
            sid=sid,
            resume_all=resume_all,
            client_id=client_id,
            print_mode=print_mode,
        )

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
        callback=callback,
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
