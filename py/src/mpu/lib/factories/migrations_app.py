"""Фабрика для appMigrations-семейства: app-level selector + опц. `--name`.

Покрывает: latest, up — `node cli service:appMigrations <method> [--name <name>]`.
Команда per-server (БД main); селектор универсальный (sl-N | client_id | spreadsheet | title).

UX: `<bin> <selector> <subcommand> [--name <name>]`, e.g.
    `mpu app-migrations sl-1 latest`
    `mpu p app-migrations 12345 up --name 20260101_test`
"""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    FlagValue,
    attach_selector_callback,
    emit_node_cli,
    resolve_from_ctx,
)


def register(
    *,
    app: typer.Typer,
    service: str,
    methods: list[tuple[str, str]],
    command_name: str,
) -> None:
    """Регистрирует subcommand'ы. `methods`: `[(sub_name, sl_back_method), ...]`."""
    attach_selector_callback(app=app, command_name=command_name)
    for sub_name, method_name in methods:
        _register_one(
            app=app,
            service=service,
            sub_name=sub_name,
            method_name=method_name,
        )


def _register_one(
    *,
    app: typer.Typer,
    service: str,
    sub_name: str,
    method_name: str,
) -> None:
    @app.command(
        name=sub_name,
        help=f"Распечатать ssh-команду для service:{service} {method_name}.",
    )
    def _cmd(  # pyright: ignore[reportUnusedFunction]
        ctx: typer.Context,
        name: Annotated[
            str | None,
            typer.Option("--name", help="Migration name"),
        ] = None,
    ) -> None:
        resolved, wrapper = resolve_from_ctx(ctx)
        flags: dict[str, FlagValue] = {"--name": name}
        cn_obj: object = ctx.obj["command_name"]
        assert isinstance(cn_obj, str)
        emit_node_cli(
            name=service,
            method=method_name,
            flags=flags,
            resolved=resolved,
            wrapper=wrapper,
            command_name=cn_obj,
        )
