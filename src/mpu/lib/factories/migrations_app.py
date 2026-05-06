"""Фабрика для appMigrations-семейства: server-only + опц. `--name`.

Покрывает: latest, up — `node cli service:appMigrations <method> [--name <name>]`.
Команда per-server (БД main); `--server sl-N` обязателен.
"""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import FlagValue, emit_node_cli, resolve_server_only


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
        server: Annotated[str, typer.Option("--server", help="Server: sl-N (required)")],
        local: Annotated[
            bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
        ] = False,
        name: Annotated[
            str | None,
            typer.Option("--name", help="Migration name"),
        ] = None,
    ) -> None:
        resolved = resolve_server_only(
            server=server, command_name=command_name, require_ssh=not local
        )
        flags: dict[str, FlagValue] = {"--name": name}
        emit_node_cli(
            name=service,
            method=method_name,
            flags=flags,
            resolved=resolved,
            wrapper="local" if local else "ssh",
            command_name=command_name,
        )
