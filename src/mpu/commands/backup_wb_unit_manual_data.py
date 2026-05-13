"""`mpu-backup-wb-unit-manual-data` — CTAS schema_<id>.wb_unit_manual_data в backups."""

from mpu.commands._backup_unit_proto import make_app

COMMAND_NAME = "mpu-backup-wb-unit-manual-data"
COMMAND_SUMMARY = "CTAS-бэкап wb_unit_manual_data в backups-схему"

app = make_app("wb", source_table="wb_unit_manual_data", command_label=COMMAND_NAME)


def run() -> None:
    """Entry point для `mpu-backup-wb-unit-manual-data`."""
    app()
