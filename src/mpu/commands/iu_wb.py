"""`mpu-iu-wb get-source-data` — service:iuWb getSourceData без флагов."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import emit_node_cli, resolve_server_only

COMMAND_NAME = "mpu-iu-wb"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="get-source-data")
def get_source_data(
    server: Annotated[str, typer.Option("--server", help="Server: sl-N (required)")],
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
) -> None:
    """Распечатать ssh-команду для service:iuWb getSourceData."""
    resolved = resolve_server_only(server=server, command_name=COMMAND_NAME, require_ssh=not local)
    emit_node_cli(
        name="iuWb",
        method="getSourceData",
        flags={},
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-iu-wb`."""
    app()
