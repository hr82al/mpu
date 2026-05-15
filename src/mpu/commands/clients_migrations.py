"""`mpu clients-migrations <method>` — печать ssh+docker команд для service:clientsMigrations.

Subcommand'ы:
- latest, up, rollback, down, init  — через фабрику (`<value>` + `--type` + `--client-id`)
- latest-all  — hand-written (без `--client-id`, fan-out по NATS)
"""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import emit_node_cli, pick_wrapper, resolve_selector
from mpu.lib.factories import migrations_with_type

COMMAND_NAME = "mpu clients-migrations"

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
    selector: Annotated[
        str,
        typer.Argument(help="sl-N либо client_id / spreadsheet / title (универсальный селектор)"),
    ],
    type_: Annotated[str, typer.Option("--type", help="Migration type: wb, main, ozon (required)")],
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    print_mode: Annotated[
        bool,
        typer.Option("--print", "-p", help="Печатать обёртку в stdout + clipboard, не выполнять"),
    ] = False,
) -> None:
    """clientsMigrations latestAll (fan-out по NATS). По умолчанию выполняет через Portainer."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=selector, server=None, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    emit_node_cli(
        name="clientsMigrations",
        method="latestAll",
        flags={"--type": type_},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
