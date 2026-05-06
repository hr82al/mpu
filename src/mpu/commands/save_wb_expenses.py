"""`mpu-wb-save-expenses` — ssh-команда для wbUnitCalculatedData.saveExpenses."""

from mpu.commands._wb_unit_calc_expenses import make_app

COMMAND_NAME = "mpu-wb-save-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для wbUnitCalculatedData.saveExpenses"

app = make_app(method="saveExpenses", command_name=COMMAND_NAME)


def run() -> None:
    """Entry point для `mpu-wb-save-expenses`."""
    app()
