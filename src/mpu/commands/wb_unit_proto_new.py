"""`mpu-wb-unit-proto-new copy-data-from-old-table` — миграция старой proto-таблицы в новую."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    auto_pick_int,
    emit_node_cli,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu-wb-unit-proto-new"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="copy-data-from-old-table")
def copy_data_from_old_table(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
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
    """Распечатать ssh-команду для service:wbUnitProtoNew copyDataFromOldTable."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    emit_node_cli(
        name="wbUnitProtoNew",
        method="copyDataFromOldTable",
        flags={"--client-id": cid},
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-wb-unit-proto-new`."""
    app()
