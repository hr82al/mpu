"""`mpu-wb-save-expenses` — ssh-команда для wbUnitCalculatedData.saveExpenses."""

from mpu.commands._ssh_node_cli import make_app
from mpu.lib.cli_wrap import run_with_wrapper

COMMAND_NAME = "mpu-wb-save-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для wbUnitCalculatedData.saveExpenses"

app = make_app(
    service="wbUnitCalculatedData",
    method="saveExpenses",
    command_name=COMMAND_NAME,
    include_nm_ids=True,
)


def run() -> None:
    """Entry point для `mpu-wb-save-expenses`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-wb-save-expenses` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
