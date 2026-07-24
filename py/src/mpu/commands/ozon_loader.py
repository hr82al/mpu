"""`mpu ozon-loader <method>` — обёртки node cli
service:ozonLoader (exec через Portainer; `--print` — печать)."""

from typing import Annotated

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    FlagValue,
    emit_node_cli,
    pick_client_id,
    pick_wrapper,
    resolve_selector,
)
from mpu.lib.factories import loader_by_seller_client

COMMAND_NAME = "mpu ozon-loader"
COMMAND_SUMMARY = "Обёртки service:ozonLoader (exec через Portainer)"

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
    help=(
        "Обёртки над `node cli service:ozonLoader` (sl-back). Дефолт — немедленное "
        "выполнение метода в проде через Portainer; `--print`/`-p` — печать команды."
    ),
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
    value: SelectorArg,
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
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    client_id: ClientIdOpt = None,
) -> None:
    """ozonLoader loadData с дефолтной 18-этапной sequence. По умолчанию — через Portainer."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = pick_client_id(resolved, client_id, command_name=COMMAND_NAME)
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
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
