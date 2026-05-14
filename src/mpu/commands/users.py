"""`mpu users <selector> <method>` — печать ssh+docker команд для service:users (на main).

Селектор универсальный: `sl-N` (обычно `sl-1` — main) либо `client_id` / spreadsheet /
title substring. UX: `mpu users sl-1 add --email foo@example.com`.
"""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    FlagValue,
    attach_selector_callback,
    emit_node_cli,
    resolve_from_ctx,
)

COMMAND_NAME = "mpu users"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

attach_selector_callback(app=app, command_name=COMMAND_NAME)


@app.command(name="add")
def add(
    ctx: typer.Context,
    email: Annotated[str, typer.Option("--email", help="User email (required)")],
    user_id: Annotated[
        int | None, typer.Option("--id", help="User id (опц., автогенерация если не задан)")
    ] = None,
    user: Annotated[str | None, typer.Option("--user", help="Username/login")] = None,
    name: Annotated[
        str | None, typer.Option("--name", help="Display name (ASCII, без пробелов)")
    ] = None,
    password: Annotated[
        str | None,
        typer.Option("--password", help="Password (ASCII; для русских — править вручную)"),
    ] = None,
    is_active: Annotated[
        bool | None, typer.Option("--is-active/--no-is-active", help="is_active flag")
    ] = None,
) -> None:
    """Распечатать ssh-команду для service:users add."""
    resolved, wrapper = resolve_from_ctx(ctx)
    flags: dict[str, FlagValue] = {
        "--email": email,
        "--id": user_id,
        "--user": user,
        "--name": name,
        "--password": password,
        "--is-active": is_active,
    }
    emit_node_cli(
        name="users",
        method="add",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )


@app.command(name="add-role")
def add_role(
    ctx: typer.Context,
    user_id: Annotated[int, typer.Option("--id", help="User id (required)")],
    role: Annotated[str, typer.Option("--role", help="Role name, например 'client'")],
) -> None:
    """Распечатать ssh-команду для service:users addRole."""
    resolved, wrapper = resolve_from_ctx(ctx)
    emit_node_cli(
        name="users",
        method="addRole",
        flags={"--id": user_id, "--role": role},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
