"""`mpu-wb-jobs <method>` — печать ssh+docker команд для service:wbJobs."""

import typer

from mpu.lib.cli_wrap import run_with_wrapper
from mpu.lib.factories import jobs_show

COMMAND_NAME = "mpu-wb-jobs"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


jobs_show.register(
    app=app,
    service="wbJobs",
    methods=[("show", "showJobs")],
    command_name=COMMAND_NAME,
)


def run() -> None:
    """Entry point для `mpu-wb-jobs`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-wb-jobs` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
