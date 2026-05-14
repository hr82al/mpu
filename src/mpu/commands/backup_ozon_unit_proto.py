"""`mpu backup-ozon-unit-proto` — CTAS schema_<id>.ozon_unit_proto в backups."""

from mpu.commands._backup_unit_proto import make_app

COMMAND_NAME = "mpu backup-ozon-unit-proto"
COMMAND_SUMMARY = "CTAS-бэкап ozon_unit_proto в backups-схему"

app = make_app("ozon")
