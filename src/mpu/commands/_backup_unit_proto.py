"""Общая логика для `mpu-backup-wb-unit-proto` и `mpu-backup-ozon-unit-proto`."""

from typing import Annotated

import typer

from mpu.lib import sql_runner
from mpu.lib.backup_sql import Marketplace, build_backup_sql
from mpu.lib.resolver import ResolveError, resolve_server


def run_backup(
    marketplace: Marketplace,
    client_id: int,
    *,
    date_suffix: str | None,
    schema_id: int | None,
    server: str | None,
    dry: bool,
) -> int:
    try:
        server_number, _ = resolve_server(str(client_id), server_override=server)
    except ResolveError as e:
        typer.echo(f"mpu-backup-{marketplace}-unit-proto: {e}", err=True)
        return 2

    try:
        sql, source_table, date = build_backup_sql(
            marketplace=marketplace,
            client_id=client_id,
            date_suffix=date_suffix,
            schema_id=schema_id,
        )
    except ValueError as e:
        typer.echo(f"mpu-backup-{marketplace}-unit-proto: {e}", err=True)
        return 2

    typer.echo(f"marketplace: {marketplace}", err=True)
    typer.echo(f"source_table: schema_{schema_id or client_id}.{source_table}", err=True)
    typer.echo(f"date_suffix: {date}", err=True)
    return sql_runner.run_sql(server_number, sql, dry=dry)


def make_app(marketplace: Marketplace) -> typer.Typer:
    app = typer.Typer(
        no_args_is_help=True,
        context_settings={"help_option_names": ["-h", "--help"]},
    )

    @app.command()
    def main(  # pyright: ignore[reportUnusedFunction]
        client_id: Annotated[int, typer.Argument(help="ID клиента (schema_<id>)")],
        date: Annotated[
            str | None,
            typer.Option("--date", help="Суффикс даты YYYYMMDD (по умолчанию — сегодня МСК)"),
        ] = None,
        schema_id: Annotated[
            int | None,
            typer.Option("--schema-id", help="Переопределить номер схемы (default = client_id)"),
        ] = None,
        server: Annotated[
            str | None, typer.Option("--server", help="Override резолва: sl-N")
        ] = None,
        dry: Annotated[bool, typer.Option("--dry", help="Только meta + SQL, без коннекта")] = False,
    ) -> None:
        code = run_backup(
            marketplace,
            client_id,
            date_suffix=date,
            schema_id=schema_id,
            server=server,
            dry=dry,
        )
        raise typer.Exit(code=code)

    return app
