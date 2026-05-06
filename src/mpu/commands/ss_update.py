"""`mpu-ss-update` — печать `docker exec` команды для ssUpdater.update.

Печатает команду формата:
    docker exec mp-sl-N-cli sh -c 'node cli service:ssUpdater update
        --client-id <id> --spreadsheet-id <ssid>
        --update-type <type> --logs <level>'

Команда только выводится в stdout, не выполняется. Без ssh-обёртки —
пользователь сам решает, как до сервера sl-N добраться.
Селектор — то же, что у `mpu-search` (client_id / spreadsheet_id substring / title substring).
"""

from typing import Annotated

import typer

from mpu.commands._ssh_node_cli import (
    check_safe,
    format_candidates,
    pick_client_id,
    pick_spreadsheet_id,
)
from mpu.lib.resolver import ResolveError, resolve_server

COMMAND_NAME = "mpu-ss-update"
COMMAND_SUMMARY = "Печать docker-команды для ssUpdater.update"


def _build_command(
    *,
    server_number: int,
    client_id: int,
    spreadsheet_id: str,
    update_type: str,
    logs: str,
) -> str:
    """Собрать `docker exec ...` строку. Все входы предполагаются прошедшими `check_safe`."""
    container = f"mp-sl-{server_number}-cli"
    inner_args = [
        "node",
        "cli",
        "service:ssUpdater",
        "update",
        "--client-id",
        str(client_id),
        "--spreadsheet-id",
        spreadsheet_id,
        "--update-type",
        update_type,
        "--logs",
        logs,
    ]
    inner = " ".join(inner_args)
    return f"docker exec {container} sh -c '{inner}'"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    server: Annotated[
        str | None, typer.Option("--server", help="Override резолва: sl-N")
    ] = None,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
    spreadsheet_id: Annotated[
        str | None,
        typer.Option(
            "--spreadsheet-id",
            "--spreadsheet_id",
            help="Override spreadsheet_id если selector неоднозначен",
        ),
    ] = None,
    update_type: Annotated[
        str,
        typer.Option(
            "--update-type", "--update_type", help="ssUpdater update-type"
        ),
    ] = "schedule",
    logs: Annotated[
        str, typer.Option("--logs", help="Logs level (info, debug, ...)")
    ] = "info",
) -> None:
    """Распечатать docker-команду в stdout (без выполнения)."""
    try:
        server_number, candidates = resolve_server(value, server_override=server)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    cid = client_id if client_id is not None else pick_client_id(candidates)
    if cid is None:
        typer.echo(
            f"{COMMAND_NAME}: cannot resolve client_id from selector; pass --client-id",
            err=True,
        )
        if candidates:
            typer.echo(format_candidates(candidates), err=True)
        raise typer.Exit(code=2)

    ssid = spreadsheet_id if spreadsheet_id is not None else pick_spreadsheet_id(candidates)
    if ssid is None:
        typer.echo(
            f"{COMMAND_NAME}: cannot resolve spreadsheet_id from selector; pass --spreadsheet-id",
            err=True,
        )
        if candidates:
            typer.echo(format_candidates(candidates), err=True)
        raise typer.Exit(code=2)

    check_safe("--spreadsheet-id", ssid)
    check_safe("--update-type", update_type)
    check_safe("--logs", logs)

    typer.echo(
        _build_command(
            server_number=server_number,
            client_id=cid,
            spreadsheet_id=ssid,
            update_type=update_type,
            logs=logs,
        )
    )


def run() -> None:
    """Entry point для `mpu-ss-update`."""
    app()
