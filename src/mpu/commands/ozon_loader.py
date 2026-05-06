"""`mpu-ozon-loader <method>` — печать ssh+docker команд для service:ozonLoader."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_int,
    emit_node_cli,
    require,
    resolve_selector,
)
from mpu.lib.factories import loader_by_seller_client

COMMAND_NAME = "mpu-ozon-loader"

# Дефолтная sequence для ozonLoader.loadData — 18-этапный пайплайн загрузки Ozon.
# Выводим как массив пробельно-разделённых токенов (sl-back parseMethodArgs читает массивом),
# чтобы избежать quoting JSON со спецсимволами в shell-обёртке.
_DEFAULT_SEQUENCE: list[str] = [
    "ozonProductInfo",
    "ozonCampaigns",
    "ozonCampaignDailyStatistics",
    "ozonAttributes",
    "ozonCommonLocalizationIndex",
    "ozonAnalytics",
    "ozonFboList",
    "ozonFbsList",
    "ozonStocks",
    "ozonActions",
    "ozonPrices",
    "ozonTransactions",
    "ozonRatingBySku",
    "ozonReturns",
    "ozonCategories",
    "ozonPerformanceReports",
    "ozonSearchPromo",
    "ozonPostingsReports",
]


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

loader_by_seller_client.register(
    app=app,
    service="ozonLoader",
    methods=[
        ("postings-reports", "ozonPostingsReports"),
        ("performance-reports", "ozonPerformanceReports"),
        ("search-promo", "ozonSearchPromo"),
        ("campaign-daily-statistics", "ozonCampaignDailyStatistics"),
        ("campaigns", "ozonCampaigns"),
        ("transactions", "ozonTransactions"),
    ],
    command_name=COMMAND_NAME,
)


@app.command(name="load-data")
def load_data(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    seller_client_ids: Annotated[
        list[int],
        typer.Option(
            "--seller-client-id",
            "--seller_client_id",
            "--seller-client-ids",
            "--seller_client_ids",
            help="Ozon seller client_id(s); flag можно повторять",
        ),
    ],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
) -> None:
    """Распечатать ssh-команду для service:ozonLoader loadData c дефолтной 18-этапной sequence."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    flags: dict[str, FlagValue] = {
        "--client-id": cid,
        "--seller-client-ids": [str(s) for s in seller_client_ids],
        "--sequence": _DEFAULT_SEQUENCE,
    }
    emit_node_cli(
        name="ozonLoader",
        method="loadData",
        flags=flags,
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-ozon-loader`."""
    app()
