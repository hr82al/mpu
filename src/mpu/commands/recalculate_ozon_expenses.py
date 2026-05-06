"""`mpu-ozon-recalculate-expenses` — ssh-команда для ozonUnitCalculatedData.recalculateExpenses."""

from mpu.commands._ssh_node_cli import make_app

COMMAND_NAME = "mpu-ozon-recalculate-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для ozonUnitCalculatedData.recalculateExpenses"

app = make_app(
    service="ozonUnitCalculatedData",
    method="recalculateExpenses",
    command_name=COMMAND_NAME,
    include_nm_ids=False,
)


def run() -> None:
    """Entry point для `mpu-ozon-recalculate-expenses`."""
    app()
