"""`mpu-wb-recalculate-expenses` — ssh-команда для wbUnitCalculatedData.recalculateExpenses."""

from mpu.commands._ssh_node_cli import make_app

COMMAND_NAME = "mpu-wb-recalculate-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для wbUnitCalculatedData.recalculateExpenses"

app = make_app(
    service="wbUnitCalculatedData",
    method="recalculateExpenses",
    command_name=COMMAND_NAME,
    include_nm_ids=True,
)


def run() -> None:
    """Entry point для `mpu-wb-recalculate-expenses`."""
    app()
