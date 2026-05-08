"""`mpu-app-migrations <method>` — печать ssh+docker команд для service:appMigrations."""

import typer

from mpu.lib.cli_wrap import run_with_wrapper
from mpu.lib.factories import migrations_app

COMMAND_NAME = "mpu-app-migrations"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

migrations_app.register(
    app=app,
    service="appMigrations",
    methods=[
        ("latest", "latest"),
        ("up", "up"),
    ],
    command_name=COMMAND_NAME,
)


def run() -> None:
    """Entry point для `mpu-app-migrations`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-app-migrations` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
