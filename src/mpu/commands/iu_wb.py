"""`mpu-iu-wb <selector> get-source-data` — service:iuWb getSourceData.

Селектор универсальный: `sl-N` либо `client_id` / spreadsheet / title substring.
"""

import typer

from mpu.lib.cli_wrap import (
    attach_selector_callback,
    emit_node_cli,
    resolve_from_ctx,
    run_with_wrapper,
)

COMMAND_NAME = "mpu-iu-wb"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

attach_selector_callback(app=app, command_name=COMMAND_NAME)


@app.command(name="get-source-data")
def get_source_data(ctx: typer.Context) -> None:
    """Распечатать ssh-команду для service:iuWb getSourceData."""
    resolved, wrapper = resolve_from_ctx(ctx)
    emit_node_cli(
        name="iuWb",
        method="getSourceData",
        flags={},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-iu-wb`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-iu-wb` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
