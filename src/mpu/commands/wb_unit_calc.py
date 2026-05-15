"""`mpu wb-unit-calc get-unit-data-by-date-nm-id` — read-only debug."""

import datetime
from typing import Annotated

import typer

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
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    nm_id: Annotated[int, typer.Option("--nm-id", "--nm_id", help="WB nm_id (required)")],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    print_mode: Annotated[
        bool,
        typer.Option("--print", "-p", help="Печатать обёртку в stdout + clipboard, не выполнять"),
    ] = False,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
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
