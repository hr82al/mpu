"""`mpu-backup-ozon-unit-proto` — CTAS schema_<id>.ozon_unit_proto в backups."""

from mpu.commands._backup_unit_proto import make_app

app = make_app("ozon")


def run() -> None:
    """Entry point для `mpu-backup-ozon-unit-proto`."""
    app()
