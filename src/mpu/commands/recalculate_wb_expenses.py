"""`mpu-wb-recalculate-expenses` — ssh-команда для wbUnitCalculatedData.recalculateExpenses."""

from mpu.commands._wb_unit_calc_expenses import make_app

COMMAND_NAME = "mpu-wb-recalculate-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для wbUnitCalculatedData.recalculateExpenses"

app = make_app(method="recalculateExpenses", command_name=COMMAND_NAME)


def run() -> None:
    """Entry point для `mpu-wb-recalculate-expenses`."""
    app()
