"""Фабрика для jobs-семейства (showJobs / pruneJobs): app-level selector + опц. `--pattern`.

Покрывает: wbJobs.showJobs, ozonJobs.{showJobs, pruneJobs}, dataLoaderJobs.showJobs.
Команда per-server (BullMQ Redis); селектор универсальный — `sl-N` либо
`client_id` / `spreadsheet_id` / `title` (резолв через `mpu-search`).

UX: `<bin> <selector> <subcommand> [--pattern <p>]`, e.g.
    `mpu-ozon-jobs sl-2 show`
    `mpup-ozon-jobs 12345 prune --pattern 'foo*'`
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
        pattern: Annotated[
            str | None,
            typer.Option("--pattern", help="Glob pattern для фильтра jobs"),
        ] = None,
    ) -> None:
        resolved, wrapper = resolve_from_ctx(ctx)
        flags: dict[str, FlagValue] = {"--pattern": pattern}
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
