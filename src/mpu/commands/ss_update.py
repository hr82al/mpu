"""`mpu ss-update` — печать ssh+docker команды для ssUpdater.update."""

from typing import Annotated

import typer

from mpu.lib.cli_opts import (
    ClientIdOpt,
    LocalOpt,
    PrintOpt,
    SelectorArg,
    ServerOpt,
    SpreadsheetIdOpt,
)
from mpu.lib.cli_wrap import (
    emit_node_cli,
    pick_client_id,
    pick_spreadsheet_id,
    pick_wrapper,
    resolve_selector,
)

COMMAND_NAME = "mpu ss-update"
COMMAND_SUMMARY = "Печать ssh+docker команды для ssUpdater.update"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: SelectorArg,
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    client_id: ClientIdOpt = None,
    spreadsheet_id: SpreadsheetIdOpt = None,
    update_type: Annotated[
        str,
        typer.Option("--update-type", "--update_type", help="ssUpdater update-type"),
    ] = "schedule",
    logs: Annotated[str, typer.Option("--logs", help="Logs level (info, debug, ...)")] = "info",
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = pick_client_id(resolved, client_id, command_name=COMMAND_NAME)
    ssid = pick_spreadsheet_id(resolved, spreadsheet_id, command_name=COMMAND_NAME)
    emit_node_cli(
        name="ssUpdater",
        method="update",
        flags={
            "--client-id": cid,
            "--spreadsheet-id": ssid,
            "--update-type": update_type,
            "--logs": logs,
        },
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
