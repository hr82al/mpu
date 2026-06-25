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

Частный случай generic `mpu api wb-loader-reset <sel> cards --state '{"cursor":null}'`
(см. commands/_wb_loader.py); отдельная команда оставлена ради доменной справки.
"""

from __future__ import annotations

from typing import NoReturn

import click

from mpu.commands._wb_loader import (
    emit_curl,
    loader_path,
    print_json,
    resolve_target_sid,
)
from mpu.commands._wb_loader import fail as _fail_base
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-cards-reset"
_ENTITY = "cards"
# Сброс курсора → следующий прогон видит cursor===null → isFullLoad (см.
# wbCardsLoader.js handleIdle). next_full_reset_at не трогаем — full-pass
# триггерится именно по cursor===null.
_RESET_BODY: dict[str, object] = {"state": {"cursor": None}}


def _fail(reason: str, *, code: int, hint: str | None = None, extra: str | None = None) -> NoReturn:
    _fail_base(COMMAND, reason, code=code, hint=hint, extra=extra)


def _run(*, selector: str, sid: str | None, client_id: int | None, print_mode: bool) -> None:
    target_sid, cid_human = resolve_target_sid(selector, sid, client_id, command=COMMAND)
    path = loader_path(target_sid, _ENTITY, "reset")

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            _fail(str(e), code=1)
        emit_curl(base_url=base_url, method="POST", path=path, body=_RESET_BODY)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        _fail(str(e), code=1)

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
    print_json({"client_id": cid_human, "sid": target_sid, "result": raw})


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
