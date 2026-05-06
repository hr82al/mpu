"""SQL шаблон для бэкапа unit_proto в schema `backups` (CTAS).

Имя бэкапа: `backups.<table>_<schema_id>_<YYYYMMDD>`.
Дата по умолчанию — сегодня в МСК (UTC+3), согласовано с конвенцией sl-back.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Literal

Marketplace = Literal["wb", "ozon"]

_TABLE_BY_MARKETPLACE: dict[Marketplace, str] = {
    "wb": "wb_unit_proto",
    "ozon": "ozon_unit_proto",
}

MSK = timezone(timedelta(hours=3))


def now_msk_yyyymmdd() -> str:
    return datetime.now(MSK).strftime("%Y%m%d")


def build_backup_sql(
    *,
    marketplace: Marketplace,
    client_id: int,
    date_suffix: str | None = None,
    schema_id: int | None = None,
    source_table_override: str | None = None,
) -> tuple[str, str, str]:
    """Возвращает `(sql, source_table, date_suffix)`.

    `schema_id` по умолчанию = `client_id`. `source_table_override` — для редких случаев
    когда нужна другая таблица в той же схеме.
    """
    source_table = source_table_override or _TABLE_BY_MARKETPLACE[marketplace]
    safe_table = re.sub(r"[^a-zA-Z0-9_]", "", source_table)
    if not safe_table:
        raise ValueError("Empty/invalid source table name")

    sid = schema_id if schema_id is not None else client_id
    if date_suffix is None:
        date = now_msk_yyyymmdd()
    elif re.fullmatch(r"\d{8}", date_suffix):
        date = date_suffix
    else:
        raise ValueError(f"date_suffix must be YYYYMMDD (8 digits), got: {date_suffix!r}")
    backup_name = f"{safe_table}_{sid}_{date}"
    sql = f"CREATE TABLE backups.{backup_name} AS\nSELECT * FROM schema_{sid}.{safe_table};"
    return sql, safe_table, date
