"""`mpu process` — ssh-команда для dataProcessor.process."""

from mpu.commands._ssh_node_cli import make_app

COMMAND_NAME = "mpu process"
COMMAND_SUMMARY = "Печать ssh-команды для dataProcessor.process"

app = make_app(
    service="dataProcessor",
    method="process",
    command_name=COMMAND_NAME,
    include_nm_ids=False,
)
