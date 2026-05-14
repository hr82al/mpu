"""`mpu backup-wb-unit-proto` — CTAS schema_<id>.wb_unit_proto в backups."""

from mpu.commands._backup_unit_proto import make_app

COMMAND_NAME = "mpu backup-wb-unit-proto"
COMMAND_SUMMARY = "CTAS-бэкап wb_unit_proto в backups-схему"

app = make_app("wb")
