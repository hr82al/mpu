"""`mpu-clients-migrations <method>` — печать ssh+docker команд для service:clientsMigrations.

Subcommand'ы:
- latest, up, rollback, down, init  — через фабрику (`<value>` + `--type` + `--client-id`)
- latest-all  — hand-written (без `--client-id`, fan-out по NATS)
"""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import emit_node_cli, resolve_server_only
from mpu.lib.factories import migrations_with_type

COMMAND_NAME = "mpu-clients-migrations"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

migrations_with_type.register(
    app=app,
    service="clientsMigrations",
    methods=[
        ("latest", "latest"),
        ("up", "up"),
        ("rollback", "rollback"),
        ("down", "down"),
        ("init", "init"),
    ],
    command_name=COMMAND_NAME,
)


@app.command(name="latest-all")
def latest_all(
    server: Annotated[str, typer.Option("--server", help="Server: sl-N (required)")],
    type_: Annotated[str, typer.Option("--type", help="Migration type: wb, main, ozon (required)")],
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
) -> None:
    """Распечатать ssh-команду для service:clientsMigrations latestAll (fan-out по NATS)."""
    resolved = resolve_server_only(server=server, command_name=COMMAND_NAME, require_ssh=not local)
    emit_node_cli(
        name="clientsMigrations",
        method="latestAll",
        flags={"--type": type_},
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-clients-migrations`."""
    app()
