"""`mpu-process` — ssh-команда для dataProcessor.process."""

from mpu.commands._ssh_node_cli import make_app
from mpu.lib.cli_wrap import run_with_wrapper

COMMAND_NAME = "mpu-process"
COMMAND_SUMMARY = "Печать ssh-команды для dataProcessor.process"

app = make_app(
    service="dataProcessor",
    method="process",
    command_name=COMMAND_NAME,
    include_nm_ids=False,
)


def run() -> None:
    """Entry point для `mpu-process`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-process` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
