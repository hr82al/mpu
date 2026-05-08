"""`mpu-ozon-jobs <method>` — печать ssh+docker команд для service:ozonJobs."""

import typer

from mpu.lib.cli_wrap import run_with_wrapper
from mpu.lib.factories import jobs_show

COMMAND_NAME = "mpu-ozon-jobs"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

jobs_show.register(
    app=app,
    service="ozonJobs",
    methods=[("show", "showJobs"), ("prune", "pruneJobs")],
    command_name=COMMAND_NAME,
)


def run() -> None:
    """Entry point для `mpu-ozon-jobs`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-ozon-jobs` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
