"""`mpu-wb-loader <method>` — печать ssh+docker команд для service:wbLoader.

Subcommand'ы:
- reports, cards, adv-auto-keywords-stats, adv-fullstats, search-texts,
  analytics-by-period, adverts, search-clusters-bids
"""

import typer

from mpu.lib.factories import loader_by_sid

COMMAND_NAME = "mpu-wb-loader"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

loader_by_sid.register(
    app=app,
    service="wbLoader",
    methods=[
        ("reports", "wbReports"),
        ("cards", "wbCards"),
        ("adv-auto-keywords-stats", "wbAdvAutoKeywordsStats"),
        ("adv-fullstats", "wbAdvFullstats"),
        ("search-texts", "wbSearchTexts"),
        ("analytics-by-period", "wbAnalyticsByPeriod"),
        ("adverts", "wbAdverts"),
        ("search-clusters-bids", "wbSearchClustersBids"),
    ],
    command_name=COMMAND_NAME,
)


def run() -> None:
    """Entry point для `mpu-wb-loader`."""
    app()
