"""`mpu wb-unit-calc get-unit-data-by-date-nm-id` — read-only debug."""

import datetime
from typing import Annotated

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    auto_pick_int,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu wb-unit-calc"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="get-unit-data-by-date-nm-id")
def get_unit_data_by_date_nm_id(
    value: SelectorArg,
    nm_id: Annotated[int, typer.Option("--nm-id", "--nm_id", help="WB nm_id (required)")],
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    client_id: ClientIdOpt = None,
    date: Annotated[
        str | None,
        typer.Option("--date", help="Дата (YYYY-MM-DD); по умолчанию — сегодня"),
    ] = None,
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    dt = date or datetime.date.today().isoformat()
    emit_node_cli(
        name="wbUnitCalc",
        method="getUnitDataByDateNmId",
        flags={"--client-id": cid, "--nm-id": nm_id, "--date": dt},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
