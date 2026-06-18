"""`mpu sql-ro` — enforced read-only SQL на удалённом PG по селектору.

То же, что `mpu sql`, но сессия открывается с `default_transaction_read_only=on`:
любой INSERT/UPDATE/DELETE/DDL (в т.ч. data-modifying CTE и пишущие функции)
отклоняется Postgres'ом (SQLSTATE 25006). Гарантия даётся самим PG, а не
статическим анализом — поэтому команду можно безопасно авто-разрешать в
Claude Code (`permissions.allow`), тогда как пишущий `mpu sql` — `permissions.ask`.

Селектор и флаги — как у `mpu sql` (см. `mpu.commands.sql`). Для записи — `mpu sql`.
"""

from typing import Annotated

import typer

from mpu.commands.sql import dispatch

COMMAND_NAME = "mpu sql-ro"
COMMAND_SUMMARY = "Read-only SQL на удалённом PG по селектору (enforced, без записи)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="client_id, spreadsheet_id substring, title substring, "
            "sw-PG алиас (sw / sw-pg / ws / workspaces), "
            "или dev-стенд `dev:<client_id>` (БД mp_sl_1_dev, search_path schema_<client_id>)"
        ),
    ],
    sql: Annotated[
        str | None,
        typer.Argument(help="SQL для выполнения (read-only); если не задан — берётся из stdin"),
    ] = None,
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    dry: Annotated[bool, typer.Option("--dry", help="Только meta + SQL, без коннекта")] = False,
    json_out: Annotated[
        bool, typer.Option("--json", help="Результат как JSON-array объектов")
    ] = False,
    md_out: Annotated[bool, typer.Option("--md", help="Результат как markdown-таблица")] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "-v", "--verbose", help="Печатать meta-блок (server, host, db, search_path, mode, SQL)"
        ),
    ] = False,
) -> None:
    dispatch(
        selector,
        sql,
        server=server,
        dry=dry,
        json_out=json_out,
        md_out=md_out,
        verbose=verbose,
        read_only=True,
        prog=COMMAND_NAME,
    )
