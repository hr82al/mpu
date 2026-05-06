"""Тесты `lib/backup_sql.build_backup_sql`."""

from datetime import datetime

import pytest

from mpu.lib import backup_sql
from mpu.lib.backup_sql import MSK, build_backup_sql, now_msk_yyyymmdd


def test_build_backup_wb() -> None:
    sql, table, date = build_backup_sql(
        marketplace="wb", client_id=1311, date_suffix="20260322"
    )
    assert table == "wb_unit_proto"
    assert date == "20260322"
    assert sql == (
        "CREATE TABLE backups.wb_unit_proto_1311_20260322 AS\n"
        "SELECT * FROM schema_1311.wb_unit_proto;"
    )


def test_build_backup_ozon() -> None:
    sql, table, _ = build_backup_sql(
        marketplace="ozon", client_id=42, date_suffix="20260101"
    )
    assert table == "ozon_unit_proto"
    assert sql == (
        "CREATE TABLE backups.ozon_unit_proto_42_20260101 AS\n"
        "SELECT * FROM schema_42.ozon_unit_proto;"
    )


def test_build_backup_default_date_msk(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = datetime(2026, 5, 6, 12, 30, tzinfo=MSK)

    class FakeDT:
        @classmethod
        def now(cls, tz: object = None) -> datetime:
            return fixed

    monkeypatch.setattr(backup_sql, "datetime", FakeDT)
    _, _, date = build_backup_sql(marketplace="wb", client_id=1)
    assert date == "20260506"


def test_build_backup_schema_id_override() -> None:
    sql, _, _ = build_backup_sql(
        marketplace="wb", client_id=10, schema_id=99, date_suffix="20260101"
    )
    assert "backups.wb_unit_proto_99_20260101" in sql
    assert "FROM schema_99.wb_unit_proto" in sql


def test_now_msk_format() -> None:
    s = now_msk_yyyymmdd()
    assert len(s) == 8
    assert s.isdigit()
