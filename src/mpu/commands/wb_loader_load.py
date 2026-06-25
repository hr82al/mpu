"""`mpu api wb-loader-load <selector> <loader>` — форс-прогон wb-loader-app загрузчика.

`POST /admin/wb-loader/loaders/<sid>/<loader>/v1/load` → `forceLoad` (promote
delayed job, немедленный прогон, не дожидаясь `data_load_cycle_ms`). После
`wb-loader-reset` догоняет окно сразу. Мутирует прод (`wbLoaderWriteGate`, роль
`support_write`+). Read-only аналог — `wb-loader-status`.

- `<loader>` — kebab-слаг (`adv-normquery-stats`, `cards`, …; автодополнение).
- Селектор / `--sid` / `--client-id` / `--print` — как у `wb-loader-status`.
"""

from __future__ import annotations

import click

from mpu.commands._wb_loader import (
    LOADER_ENTITIES,
    complete_entity,
    emit_curl,
    fail,
    loader_path,
    print_json,
    resolve_target_sid,
)
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-loader-load"


def _run(
    *, selector: str, loader: str, sid: str | None, client_id: int | None, print_mode: bool
) -> None:
    if loader not in LOADER_ENTITIES:
        fail(
            COMMAND,
            f"неизвестный loader {loader!r}",
            code=2,
            hint=f"один из: {', '.join(LOADER_ENTITIES)}",
        )
    target_sid, cid_human = resolve_target_sid(selector, sid, client_id, command=COMMAND)
    path = loader_path(target_sid, loader, "load")

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            fail(COMMAND, str(e), code=1)
        emit_curl(base_url=base_url, method="POST", path=path)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        fail(COMMAND, str(e), code=1)
    try:
        raw: object = api.request("POST", path)
    except SlApiError as e:
        if e.status == 403:
            fail(
                COMMAND,
                "load запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        fail(COMMAND, f"load не удался: {e}", code=1, extra=e.body)
    click.echo(f"# client {cid_human} sid {target_sid} loader {loader}: force load", err=True)
    print_json({"client_id": cid_human, "sid": target_sid, "loader": loader, "load": raw})


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    def callback(
        selector: str, loader: str, sid: str | None, client_id: int | None, print_mode: bool
    ) -> None:
        _run(selector=selector, loader=loader, sid=sid, client_id=client_id, print_mode=print_mode)

    params: list[click.Parameter] = [
        click.Argument(["selector"], required=True, type=str),
        click.Argument(["loader"], required=True, type=str, shell_complete=complete_entity),
        click.Option(
            ["--sid"],
            default=None,
            type=str,
            help="Явный WB sid: прямой режим, без резолва клиента",
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
            help="Напечатать эквивалентный curl (+ буфер), без выполнения",
        ),
    ]

    return click.Command(
        name="wb-loader-load",
        params=params,
        callback=callback,
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
