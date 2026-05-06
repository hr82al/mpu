"""Выполнение SQL на удалённом PG-сервере (sl-N) через psycopg.

Печатает meta-блок (pg_host/port/database/sql) в stderr, выполняет SQL, форматирует
результат: SELECT → таблица или JSON, DDL/DML без result-set → `OK (rowcount=N)`.
"""

import json
import sys
from typing import IO, Any

import psycopg
import typer

from mpu.lib import pg, servers


def _print_meta(server_number: int, sql: str, *, stream: IO[str]) -> None:
    host = servers.pg_ip(server_number)
    port = servers.env_value("PG_PORT") or "5432"
    db = servers.env_value("PG_DB_NAME") or "wb"
    print(f"server: sl-{server_number}", file=stream)
    print(f"pg_host: {host}", file=stream)
    print(f"pg_port: {port}", file=stream)
    print(f"database: {db}", file=stream)
    print("sql:", file=stream)
    print(sql, file=stream)


def _print_table(cols: list[str], rows: list[tuple[Any, ...]], stream: IO[str]) -> None:
    if not rows:
        print("\t".join(cols), file=stream)
        print("(0 rows)", file=stream)
        return
    str_rows = [[("" if v is None else str(v)) for v in row] for row in rows]
    widths = [max(len(c), *(len(r[i]) for r in str_rows)) for i, c in enumerate(cols)]
    sep = "  "
    print(sep.join(c.ljust(widths[i]) for i, c in enumerate(cols)), file=stream)
    print(sep.join("-" * w for w in widths), file=stream)
    for r in str_rows:
        print(sep.join(r[i].ljust(widths[i]) for i in range(len(cols))), file=stream)
    print(f"({len(rows)} rows)", file=stream)


def run_sql(
    server_number: int,
    sql: str,
    *,
    dry: bool = False,
    json_out: bool = False,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> int:
    """Выполнить SQL на sl-<server_number>. Возвращает exit code (0 / 1)."""
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    _print_meta(server_number, sql, stream=err)

    if dry:
        return 0

    try:
        with pg.connect_to(server_number) as conn, conn.cursor() as cur:
            cur.execute(sql)  # type: ignore[arg-type]
            if cur.description is None:
                if json_out:
                    print(json.dumps({"ok": True, "rowcount": cur.rowcount}), file=out)
                else:
                    print(f"OK (rowcount={cur.rowcount})", file=out)
                return 0
            cols = [d.name for d in cur.description]
            rows = cur.fetchall()
            if json_out:
                print(
                    json.dumps(
                        [dict(zip(cols, r, strict=False)) for r in rows],
                        ensure_ascii=False,
                        default=str,
                    ),
                    file=out,
                )
            else:
                _print_table(cols, rows, out)
            return 0
    except psycopg.Error as e:
        typer.echo(f"db error: {e}", err=True)
        return 1
