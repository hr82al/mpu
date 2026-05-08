"""`mpu-data-loader <method>` — печать ssh+docker команд для service:dataLoader."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_int,
    emit_node_cli,
    require,
    resolve_selector,
    run_with_wrapper,
)

COMMAND_NAME = "mpu-data-loader"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="find-candidate")
def find_candidate(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    sids: Annotated[
        list[str],
        typer.Option("--sids", "--sid", help="WB cabinet sid(s); flag можно повторять"),
    ],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
) -> None:
    """Распечатать ssh-команду для service:dataLoader findCandidate."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    flags: dict[str, FlagValue] = {"--client-id": cid, "--sids": sids}
    emit_node_cli(
        name="dataLoader",
        method="findCandidate",
        flags=flags,
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-data-loader`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-data-loader` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
