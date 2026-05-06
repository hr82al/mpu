"""`mpu-users <method>` — печать ssh+docker команд для service:users (на main)."""

from typing import Annotated

import typer

from mpu.lib.cli_wrap import FlagValue, emit_node_cli, resolve_server_only

COMMAND_NAME = "mpu-users"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command(name="add")
def add(
    server: Annotated[str, typer.Option("--server", help="Server: sl-N (main, обычно sl-1)")],
    email: Annotated[str, typer.Option("--email", help="User email (required)")],
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
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
    resolved = resolve_server_only(server=server, command_name=COMMAND_NAME, require_ssh=not local)
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
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


@app.command(name="add-role")
def add_role(
    server: Annotated[str, typer.Option("--server", help="Server: sl-N (main)")],
    user_id: Annotated[int, typer.Option("--id", help="User id (required)")],
    role: Annotated[str, typer.Option("--role", help="Role name, например 'client'")],
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
) -> None:
    """Распечатать ssh-команду для service:users addRole."""
    resolved = resolve_server_only(server=server, command_name=COMMAND_NAME, require_ssh=not local)
    emit_node_cli(
        name="users",
        method="addRole",
        flags={"--id": user_id, "--role": role},
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=COMMAND_NAME,
    )


def run() -> None:
    """Entry point для `mpu-users`."""
    app()
