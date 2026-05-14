"""`mpu copy-client <selector>` — скопировать клиента с удалённого PG в локальный dev-PG.

Гонит `node ./src/clientsTransfer.js copy` внутри локального `dt-host-cli` контейнера
(`compose.sl-dt-host.yaml`). Source-PG резолвится из селектора (`mpu search`-семантика:
client_id / spreadsheet_id substring / title substring / sl-N). Target — всегда `sl-1`
(локальный dev), `127.0.0.1:5441`.

`--skip INIT CREATE_TARGET_SCHEMA VERIFY_CLIENT_SCHEMA` — захардкоженно, как в старой
fish-функции `copy-client`.
"""

from typing import Annotated

import typer

from mpu.lib import dt_host, servers
from mpu.lib.resolver import ResolveError, resolve_server

COMMAND_NAME = "mpu copy-client"
COMMAND_SUMMARY = "Скопировать клиента с удалённого PG в локальный dev-PG через dt-host"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _format_candidates(candidates: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for c in candidates:
        parts = [f"client_id={c.get('client_id')}", f"server={c.get('server')}"]
        if title := c.get("title"):
            parts.append(f'title="{title}"')
        if ss := c.get("spreadsheet_id"):
            parts.append(f"spreadsheet_id={ss}")
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)


def _pick_client_id(candidates: list[dict[str, object]]) -> int:
    ids = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    if not ids:
        typer.echo(
            f"{COMMAND_NAME}: selector resolved to a server but no client_id; "
            f"use a selector that points to a specific client",
            err=True,
        )
        if candidates:
            typer.echo(_format_candidates(candidates), err=True)
        raise typer.Exit(code=2)
    if len(ids) > 1:
        typer.echo(
            f"{COMMAND_NAME}: selector matches {len(ids)} clients — narrow it down",
            err=True,
        )
        typer.echo(_format_candidates(candidates), err=True)
        raise typer.Exit(code=2)
    return next(iter(ids))


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="client_id / spreadsheet_id substring / title substring / sl-N "
            "(должен резолвиться в одного клиента)"
        ),
    ],
) -> None:
    """Скопировать клиента с удалённого PG в локальный dev-PG (`sl-1`)."""
    try:
        server_number, candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    if not candidates:
        typer.echo(
            f"{COMMAND_NAME}: selector {selector!r} resolved to sl-{server_number} "
            f"but does not point to a specific client; pass client_id / spreadsheet / title",
            err=True,
        )
        raise typer.Exit(code=2)

    client_id = _pick_client_id(candidates)

    source_host = servers.pg_ip(server_number)
    if source_host is None:
        typer.echo(
            f"{COMMAND_NAME}: pg_{server_number} not found in ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)

    inner = (
        f"USE_NATS_PROXY=false "
        f"WB_PLUS_WEB_APP_EMAIL='dev007.btlz@gmail.com' "
        f"SOURCE_HOST={source_host} "
        f"SOURCE_PORT=5432 "
        f"TARGET_HOST=127.0.0.1 "
        f"TARGET_PORT=5441 "
        f"node ./src/clientsTransfer.js copy "
        f"--client-id {client_id} "
        f"--source sl-{server_number} "
        f"--target sl-1 "
        f"--skip INIT CREATE_TARGET_SCHEMA VERIFY_CLIENT_SCHEMA"
    )

    rc = dt_host.exec_cli(inner, command_name=COMMAND_NAME)
    raise typer.Exit(code=rc)
