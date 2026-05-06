"""`mpu-ss-update` — печать ssh+docker команды для ssUpdater.update."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    auto_pick_int,
    auto_pick_str,
    emit_node_cli,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu-ss-update"
COMMAND_SUMMARY = "Печать ssh+docker команды для ssUpdater.update"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool,
        typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)"),
    ] = False,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
    spreadsheet_id: Annotated[
        str | None,
        typer.Option(
            "--spreadsheet-id",
            "--spreadsheet_id",
            help="Override spreadsheet_id если selector неоднозначен",
        ),
    ] = None,
    update_type: Annotated[
        str,
        typer.Option("--update-type", "--update_type", help="ssUpdater update-type"),
    ] = "schedule",
    logs: Annotated[str, typer.Option("--logs", help="Logs level (info, debug, ...)")] = "info",
) -> None:
    """Распечатать docker-команду в stdout (без выполнения)."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    ssid = require(
        spreadsheet_id
        if spreadsheet_id is not None
        else auto_pick_str(resolved.candidates, "spreadsheet_id"),
        flag="--spreadsheet-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
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
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-ss-update`."""
    app()
