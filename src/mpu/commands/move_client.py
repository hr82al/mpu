"""`mpu-move-client <selector> [--target sl-N]` — перенос клиента между sl-серверами.

Сценарий: source-server резолвится из селектора (`mpu-search`-семантика), target
по умолчанию `sl-1`, `--destroy` всегда включён (это move, а не copy).

Запускает `node cli service:clientsTransfer createJob ...` в контейнере `mp-dt-cli`
через Portainer (универсальный путь `pssh.pssh_run_container`). `createJob` кладёт
BullMQ-job в очередь `transferClient` (см. `clientsTransfer.service.js:createJob`);
реальный перенос исполняют воркеры `mp-dt-clients-transfer-workers`.
"""

import shlex
from typing import Annotated

import typer

from mpu.lib import containers, pssh, servers
from mpu.lib.resolver import ResolveError, resolve_server

MP_DT_CONTAINER = "mp-dt-cli"

COMMAND_NAME = "mpu-move-client"
COMMAND_SUMMARY = "Перенести клиента между sl-серверами (createJob через mp-dt-cli)"

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
            "(должен резолвиться в одного клиента; source = резолв)"
        ),
    ],
    target: Annotated[
        str,
        typer.Option("--target", help="Target sl-N (default sl-1)"),
    ] = "sl-1",
) -> None:
    """Перенести клиента с source-sl на target-sl через mp-dt-cli (BullMQ createJob)."""
    try:
        source_n, candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    if not candidates:
        typer.echo(
            f"{COMMAND_NAME}: selector {selector!r} resolved to sl-{source_n} "
            f"but does not point to a specific client; pass client_id / spreadsheet / title",
            err=True,
        )
        raise typer.Exit(code=2)

    client_id = _pick_client_id(candidates)

    target_n = servers.server_number(target)
    if target_n is None:
        typer.echo(
            f"{COMMAND_NAME}: bad --target {target!r} (expected sl-N)",
            err=True,
        )
        raise typer.Exit(code=2)

    if target_n == source_n:
        typer.echo(
            f"{COMMAND_NAME}: source и target оба sl-{source_n} — нечего переносить",
            err=True,
        )
        raise typer.Exit(code=2)

    cmd = [
        "node",
        "cli",
        "service:clientsTransfer",
        "createJob",
        "--source",
        f"sl-{source_n}",
        "--target",
        f"sl-{target_n}",
        "--client-id",
        str(client_id),
        "--destroy",
    ]
    typer.echo(f"$ {shlex.join(cmd)}  (in {MP_DT_CONTAINER})", err=True)
    try:
        rc = pssh.pssh_run_container(container=MP_DT_CONTAINER, cmd=cmd)
    except containers.ContainerResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(containers.format_container_candidates(e.candidates), err=True)
        else:
            typer.echo(
                f"{COMMAND_NAME}: запусти `mpu init` для обновления Portainer-кэша",
                err=True,
            )
        raise typer.Exit(code=2) from None
    raise typer.Exit(code=rc)


def run() -> None:
    """Entry point для `mpu-move-client`."""
    app()
