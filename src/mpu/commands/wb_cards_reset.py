"""`mpu api wb-cards-reset <selector>` — форсировать полный проход загрузчика
`wbCards` (склейки) для WB-кабинета.

Зачем: WB **не бампает** `updatedAt` карточки при изменении только склейки
(`imt_id`), поэтому инкрементальный проход `wbCards` (по курсору `updatedAt`)
пропускает переклеенные карточки — новый `imt_id` подтянется лишь на
еженедельном full-pass (`FULL_RESET_INTERVAL_MS = 7д`). Из-за этого после
переклейки на МП склейки в системе/на РНП отстают до недели. Эта команда
сбрасывает курсор загрузчика в `null` → ближайший прогон делает полный
re-fetch всех карточек с актуальным `imt_id`, затем `cards.loaded` → sync в
sl-back → пересчёт датасетов.

Путь: `POST /admin/wb-loader/loaders/<sid>/cards/v1/reset` body
`{state:{cursor:null}}`. sl-back main проксирует `/admin/wb-loader/<rest>` →
wb-main `/api/<rest>`, а wb-main маршрутизирует `/api/loaders/:sid/*` на
инстанс, владеющий SID (см.
`sl-back/src/wbLoaderInstanceApp/wbLoaders/standardLoaderRoutes.js` — route
`reset`). POST гейтится `wbLoaderWriteGate` (`SUPPORT_WRITE_PLUS_ROLES`).

Селектор — любой из `mpu search` (client_id / spreadsheet / title / **sid**).
Прямой режим по sid (reset идёт по sid напрямую, без резолва клиента)
включается если задан явный `--sid` ИЛИ селектор сам — полный sid (UUID-форма):
на wb-loader-app загрузчик keyed by sid, а client_id / server — косметика.
Иначе sid берётся из кэша (`mpu search`); при нескольких sid нужен `--sid`.

- `mpu api wb-cards-reset <selector>` — сбросить курсор и запустить full-pass.
- `--sid <sid>` — явный sid (прямой режим).
- `--client-id <id>` — явный client_id при неоднозначном селекторе.
- `--print` / `-p` — напечатать эквивалентный curl (+ буфер), без выполнения.
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

COMMAND = "mpu api wb-cards-reset"

# sl-back main проксирует `/admin/wb-loader/<rest>` → wb-main `/api/<rest>`,
# wb-main → инстанс по sid. `v1` обязателен, иначе upstream 404.
_RESET_PATH_TMPL = "/admin/wb-loader/loaders/{sid}/cards/v1/reset"
# Сброс курсора → следующий прогон видит cursor===null → isFullLoad (см.
# wbCardsLoader.js handleIdle). next_full_reset_at не трогаем — full-pass
# триггерится именно по cursor===null.
_RESET_BODY: dict[str, object] = {"state": {"cursor": None}}

# UUID-форма WB sid (8-4-4-4-12 hex).
_SID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _looks_like_sid(value: str) -> bool:
    """`value` — полный WB sid (UUID-форма) → reset идёт по sid напрямую."""
    return bool(_SID_RE.match(value))


def _fail(reason: str, *, code: int, hint: str | None = None, extra: str | None = None) -> NoReturn:
    """Машинно-читаемая ошибка → exit."""
    msg = f"{COMMAND}: {reason}"
    if hint:
        msg += f"; попробуй: {hint}"
    click.echo(msg, err=True)
    if extra:
        click.echo(extra, err=True)
    raise SystemExit(code)


def _print_json(value: object) -> None:
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))


def _is_obj_list(o: object) -> TypeGuard[list[object]]:
    return isinstance(o, list)


def _resolve_sids(selector: str, client_id: int | None) -> tuple[int, list[str]]:
    """Селектор → `(client_id, sids)` из локального кэша (`mpu search`)."""
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


def _pick_sid(selector: str, sids: list[str]) -> str:
    """sid из селектора (точное/однозначный substring) > единственный > exit 2."""
    exact = [s for s in sids if s == selector]
    if len(exact) == 1:
        return exact[0]
    substr = [s for s in sids if selector and selector in s]
    if not exact and len(substr) == 1:
        return substr[0]
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


def _emit_curl(*, base_url: str, sid: str) -> None:
    """Напечатать эквивалентный curl (+ буфер), ничего не выполняя."""
    path = _RESET_PATH_TMPL.format(sid=sid)
    body = json.dumps(_RESET_BODY, ensure_ascii=False)
    snippet = (
        "TOKEN=$(mpu api get-token)\n"
        f'curl -sS -X POST "{base_url}{path}" '
        '-H "authorization: Bearer $TOKEN" '
        "-H 'content-type: application/json' "
        f"-d '{body}'"
    )
    click.echo(snippet)
    copy_to_clipboard(snippet)


def _resolve_target_sid(selector: str, sid: str | None, client_id: int | None) -> tuple[str, str]:
    """→ `(sid, client_id_label)`. Прямой режим по sid не требует резолва клиента."""
    direct_sid = sid if sid is not None else (selector if _looks_like_sid(selector) else None)
    if direct_sid is not None:
        return direct_sid, (str(client_id) if client_id is not None else "?")
    cid, sids = _resolve_sids(selector, client_id)
    return _pick_sid(selector, sids), str(cid)


def _run(*, selector: str, sid: str | None, client_id: int | None, print_mode: bool) -> None:
    target_sid, cid_human = _resolve_target_sid(selector, sid, client_id)

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            _fail(str(e), code=1)
        _emit_curl(base_url=base_url, sid=target_sid)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        _fail(str(e), code=1)

    path = _RESET_PATH_TMPL.format(sid=target_sid)
    try:
        raw: object = api.request("POST", path, body=_RESET_BODY)
    except SlApiError as e:
        if e.status == 403:
            _fail(
                "reset запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        _fail(f"reset не удался: {e}", code=1, extra=e.body)
    click.echo(f"# client {cid_human} sid {target_sid}: wbCards cursor reset → full-pass", err=True)
    _print_json({"client_id": cid_human, "sid": target_sid, "result": raw})


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    def callback(selector: str, sid: str | None, client_id: int | None, print_mode: bool) -> None:
        _run(selector=selector, sid=sid, client_id=client_id, print_mode=print_mode)

    params: list[click.Parameter] = [
        click.Argument(["selector"], required=True, type=str),
        click.Option(
            ["--sid"],
            default=None,
            type=str,
            help="Явный WB sid: прямой режим, reset по этому sid напрямую",
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
        name="wb-cards-reset",
        params=params,
        callback=callback,
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
