"""`mpu wb-save-expenses` — ssh-команда для wbUnitCalculatedData.saveExpenses."""

from mpu.commands._ssh_node_cli import make_app

COMMAND_NAME = "mpu wb-save-expenses"
COMMAND_SUMMARY = "Печать ssh-команды для wbUnitCalculatedData.saveExpenses"

app = make_app(
    service="wbUnitCalculatedData",
    method="saveExpenses",
    command_name=COMMAND_NAME,
    include_nm_ids=True,
)
