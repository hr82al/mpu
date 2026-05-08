"""`mpu-ss-datasets <method>` — печать ssh+docker команд для service:ssDatasets."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_str,
    emit_node_cli,
    require,
    resolve_selector,
    run_with_wrapper,
)

COMMAND_NAME = "mpu-ss-datasets"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="add")
def add(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    dataset: Annotated[str, typer.Option("--dataset", help="Dataset name (required)")],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    spreadsheet_id: Annotated[
        str | None,
        typer.Option(
            "--spreadsheet-id",
            "--spreadsheet_id",
            help="Override spreadsheet_id если selector неоднозначен",
        ),
    ] = None,
    sheet_name: Annotated[
        str | None,
        typer.Option("--sheet-name", "--sheet_name", help="Sheet name (ASCII без spaces)"),
    ] = None,
    is_active: Annotated[
        bool | None,
        typer.Option("--is-active/--no-is-active", help="is_active flag (опц.)"),
    ] = None,
) -> None:
    """Распечатать ssh-команду для service:ssDatasets add."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
    )
    ssid = require(
        spreadsheet_id
        if spreadsheet_id is not None
        else auto_pick_str(resolved.candidates, "spreadsheet_id"),
        flag="--spreadsheet-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    flags: dict[str, FlagValue] = {
        "--spreadsheet-id": ssid,
        "--dataset": dataset,
        "--sheet-name": sheet_name,
        "--is-active": is_active,
    }
    emit_node_cli(
        name="ssDatasets",
        method="add",
        flags=flags,
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-ss-datasets`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-ss-datasets` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
