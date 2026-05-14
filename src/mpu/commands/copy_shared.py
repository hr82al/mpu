"""`mpu-copy-shared <selector>` — скопировать общие справочные таблицы (schema=shared)
с удалённого PG в локальный dev-PG.

Source-PG резолвится из селектора. Прогоняет `node src/pgDataTransfer.js transferTables`
в `dt-host-cli` контейнере (`compose.sl-dt-host.yaml`). Target — локальный `127.0.0.1:5441`.

Список таблиц — захардкожен (соответствует старой fish-функции `copy-shared`).
"""

from typing import Annotated

import typer

from mpu.lib import dt_host, servers
from mpu.lib.resolver import ResolveError, resolve_server

COMMAND_NAME = "mpu-copy-shared"
COMMAND_SUMMARY = "Скопировать shared-таблицы с удалённого PG в локальный dev-PG"

SHARED_TABLES: tuple[str, ...] = (
    "currency_rates",
    "mp_stats_wb_conversions",
    "mp_stats_wb_subjects_cards_ratings",
    "mp_stats_wb_subjects_buyouts_percents",
    "mp_manager_wb_adverts_conversions_search",
    "mp_manager_wb_adverts_conversions_auto",
    "mp_manager_wb_conversions",
    "wb_subjects",
    "wb_tariffs_box",
    "wb_tariffs_commissions",
    "wb_warehouses_okrug_names",
    "wb_storages_priority",
    "wb_calendar_promotions",
    "wb_tariffs_pallet",
    "ozon_categories",
    "ozon_localization_coefficients",
    "ozon_actions",
    "ozon_size_attributes_priority",
)

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _format_candidates(candidates: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for c in candidates:
        parts = [f"client_id={c.get('client_id')}", f"server={c.get('server')}"]
        if title := c.get("title"):
            parts.append(f'title="{title}"')
        if ss := c.get("spreadsheet_id"):
            parts.append(f"spreadsheet_id={ss}")
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="sl-N / client_id / spreadsheet_id substring / title substring "
            "(определяет source-сервер)"
        ),
    ],
) -> None:
    """Скопировать shared-таблицы с source-сервера, выбранного через селектор."""
    try:
        server_number, _ = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    source_host = servers.pg_ip(server_number)
    if source_host is None:
        typer.echo(
            f"{COMMAND_NAME}: pg_{server_number} not found in ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)

    tables = " ".join(SHARED_TABLES)
    inner = (
        f"node src/pgDataTransfer.js transferTables "
        f"--s-host={source_host} --s-port=5432 "
        f"--t-port 5441 "
        f"--schema shared "
        f"--tables {tables}"
    )

    rc = dt_host.exec_cli(inner, command_name=COMMAND_NAME)
    raise typer.Exit(code=rc)


def run() -> None:
    """Entry point для `mpu-copy-shared`."""
    app()
