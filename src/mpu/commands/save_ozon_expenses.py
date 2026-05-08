"""`mpu-ozon-save-expenses` — ssh-команда для ozonUnitCalculatedData.saveExpenses."""

from mpu.commands._ssh_node_cli import make_app
from mpu.lib.cli_wrap import run_with_wrapper

COMMAND_NAME = "mpu-ozon-save-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для ozonUnitCalculatedData.saveExpenses"

app = make_app(
    service="ozonUnitCalculatedData",
    method="saveExpenses",
    command_name=COMMAND_NAME,
    include_nm_ids=False,
)


def run() -> None:
    """Entry point для `mpu-ozon-save-expenses`."""
    app()


def run_portainer() -> None:
    """Entry point для `mpup-ozon-save-expenses` — `mpup-ssh <selector> -- node ...`."""
    run_with_wrapper(app, "portainer")
