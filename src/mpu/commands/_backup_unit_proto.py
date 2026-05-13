"""Общая логика для `mpu-backup-{wb,ozon}-unit-proto` и `mpu-backup-wb-unit-manual-data`.

Аргумент — селектор `mpu-search` (sl-N / client_id / spreadsheet_id substring / title
substring). Резолв в `(server_number, candidates)` через `resolve_server`; client_id
для имени схемы берётся из единственного `client_id` среди кандидатов. Если
кандидатов нет (например, при `--server sl-N` override) и селектор — чистое число,
оно трактуется как client_id; иначе требуется `--schema-id`.
"""

from typing import Annotated

import typer

from mpu.lib import sql_runner
from mpu.lib.backup_sql import Marketplace, build_backup_sql
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server


def _derive_client_id(selector: str, candidates: list[dict[str, object]]) -> int | None:
    """client_id из mpu-search кандидатов (один уникальный) или чистого numeric selector."""
    distinct = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    if len(distinct) == 1:
        return next(iter(distinct))
    if distinct:
        return None
    if selector.isdigit():
        return int(selector)
    return None


def run_backup(
    marketplace: Marketplace,
    selector: str,
    *,
    date_suffix: str | None,
    schema_id: int | None,
    server: str | None,
    dry: bool,
    source_table: str | None = None,
    command_label: str | None = None,
) -> int:
    label = command_label or f"mpu-backup-{marketplace}-unit-proto"
    try:
        server_number, candidates = resolve_server(selector, server_override=server)
    except ResolveError as e:
        typer.echo(f"{label}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        return 2

    if schema_id is None:
        derived = _derive_client_id(selector, candidates)
        if derived is None:
            typer.echo(
                f"{label}: cannot derive client_id from selector {selector!r}; "
                f"pass --schema-id explicitly",
                err=True,
            )
            if candidates:
                typer.echo(format_candidates(candidates), err=True)
            return 2
        effective_schema_id = derived
    else:
        effective_schema_id = schema_id

    try:
        sql, resolved_table, date = build_backup_sql(
            marketplace=marketplace,
            client_id=effective_schema_id,
            date_suffix=date_suffix,
            schema_id=schema_id,
            source_table_override=source_table,
        )
    except ValueError as e:
        typer.echo(f"{label}: {e}", err=True)
        return 2

    typer.echo(f"marketplace: {marketplace}", err=True)
    typer.echo(f"source_table: schema_{effective_schema_id}.{resolved_table}", err=True)
    typer.echo(f"date_suffix: {date}", err=True)
    return sql_runner.run_sql(server_number, sql, dry=dry)


def make_app(
    marketplace: Marketplace,
    *,
    source_table: str | None = None,
    command_label: str | None = None,
) -> typer.Typer:
    app = typer.Typer(
        no_args_is_help=True,
        context_settings={"help_option_names": ["-h", "--help"]},
    )

    @app.command()
    def main(  # pyright: ignore[reportUnusedFunction]
        selector: Annotated[
            str,
            typer.Argument(
                help="client_id / spreadsheet_id substring / title substring / sl-N"
            ),
        ],
        date: Annotated[
            str | None,
            typer.Option("--date", help="Суффикс даты YYYYMMDD (по умолчанию — сегодня МСК)"),
        ] = None,
        schema_id: Annotated[
            int | None,
            typer.Option(
                "--schema-id",
                help="Переопределить номер схемы (default = client_id из mpu-search)",
            ),
        ] = None,
        server: Annotated[
            str | None, typer.Option("--server", help="Override резолва: sl-N")
        ] = None,
        dry: Annotated[bool, typer.Option("--dry", help="Только meta + SQL, без коннекта")] = False,
    ) -> None:
        code = run_backup(
            marketplace,
            selector,
            date_suffix=date,
            schema_id=schema_id,
            server=server,
            dry=dry,
            source_table=source_table,
            command_label=command_label,
        )
        raise typer.Exit(code=code)

    return app
