"""Фабрика для ozonLoader: `<value>` selector + `--seller-client-id` + auto-pick `--client-id`.

Покрывает: ozonPostingsReports, ozonPerformanceReports, ozonSearchPromo,
ozonCampaignDailyStatistics, ozonCampaigns, ozonTransactions — все вызовы вида
`node cli service:ozonLoader <method> --client-id <id> --seller-client-id <sid>`.

ozonLoader.loadData оформляется отдельно (требует --sequence с дефолтом списка из 18 шагов).
"""

from typing import Annotated

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    auto_pick_int,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)


def register(
    *,
    app: typer.Typer,
    service: str,
    methods: list[tuple[str, str]],
    command_name: str,
) -> None:
    """Регистрирует subcommand'ы. `methods`: `[(sub_name, sl_back_method), ...]`."""
    for sub_name, method_name in methods:
        _register_one(
            app=app,
            service=service,
            sub_name=sub_name,
            method_name=method_name,
            command_name=command_name,
        )


def _register_one(
    *,
    app: typer.Typer,
    service: str,
    sub_name: str,
    method_name: str,
    command_name: str,
) -> None:
    @app.command(
        name=sub_name,
        help=f"Распечатать ssh-команду для service:{service} {method_name}.",
    )
    def _cmd(  # pyright: ignore[reportUnusedFunction]
        value: SelectorArg,
        seller_client_id: Annotated[
            str,
            typer.Option(
                "--seller-client-id",
                "--seller_client_id",
                help="Ozon seller client_id (required)",
            ),
        ],
        server: ServerOpt = None,
        local: LocalOpt = False,
        print_mode: PrintOpt = False,
        client_id: ClientIdOpt = None,
    ) -> None:
        wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
        resolved = resolve_selector(
            value=value, server=server, command_name=command_name, require_ssh=require_ssh
        )
        cid = require(
            client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
            flag="--client-id",
            candidates=resolved.candidates,
            command_name=command_name,
        )
        emit_node_cli(
            name=service,
            method=method_name,
            flags={"--client-id": cid, "--seller-client-id": seller_client_id},
            resolved=resolved,
            wrapper=wrapper,
            command_name=command_name,
        )
