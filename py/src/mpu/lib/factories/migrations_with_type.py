"""Фабрика для clientsMigrations: `<value>` + `--type` + `--client-id` + `--name`/`--forced`.

Покрывает: latest, up, rollback, down, init. `latestAll` — другой shape (без `--client-id`),
оформляется hand-written в clients_migrations.py.
"""

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
        type_: Annotated[
            str, typer.Option("--type", help="Migration type: wb, main, ozon (required)")
        ],
        server: ServerOpt = None,
        local: LocalOpt = False,
        print_mode: PrintOpt = False,
        client_id: ClientIdOpt = None,
        name: Annotated[
            str | None,
            typer.Option("--name", help="Migration name (для up/down)"),
        ] = None,
        forced: Annotated[bool, typer.Option("--forced", help="Forced flag")] = False,
    ) -> None:
        wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
        resolved = resolve_selector(
            value=value, server=server, command_name=command_name, require_ssh=require_ssh
        )
        cid = pick_client_id(resolved, client_id, command_name=command_name)
        flags: dict[str, FlagValue] = {
            "--client-id": cid,
            "--type": type_,
            "--name": name,
            "--forced": forced,
        }
        emit_node_cli(
            name=service,
            method=method_name,
            flags=flags,
            resolved=resolved,
            wrapper=wrapper,
            command_name=command_name,
        )
