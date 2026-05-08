"""`mpu-datasets-migrations <method>` — печать ssh+docker команд для service:datasetsMigrations."""

import typer

from mpu.lib.cli_wrap import run_with_wrapper
from mpu.lib.factories import migrations_with_dataset

COMMAND_NAME = "mpu-datasets-migrations"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

migrations_with_dataset.register(
    app=app,
    service="datasetsMigrations",
    methods=[
        ("latest", "latest"),
        ("up", "up"),
        ("rollback", "rollback"),
        ("down", "down"),
        ("list", "list"),
    ],
    command_name=COMMAND_NAME,
)


def run() -> None:
    """Entry point для `mpu-datasets-migrations`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-datasets-migrations` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
