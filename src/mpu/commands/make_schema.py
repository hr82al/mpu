"""`mpu make-schema <selector>` — создать схему клиента ЛОКАЛЬНО (clientsMigrations init).

Порт fish-функции `make-schema` (mr/config/aliases.fish):

    ba sl-1-cli node sl-instance service:clientsMigrations init --client-id <id> --server sl-1

`sl-1-cli` — это `docker compose ... exec -it cli` локального dev-стека (mp-config-local),
а НЕ Portainer-прод. Поэтому команда выполняется локально через `docker exec mp-sl-N-cli`,
а не через Portainer-обёртку (`emit_node_cli`). Контейнер по умолчанию `sl-1` (как в
исходной fish-функции), переопределяется через `--server`; client_id резолвится из
селектора (`mpu search`).

`init` под капотом зовёт `checkSchema()` — создаёт `schema_<client_id>` если её ещё нет
(метод игнорирует `--server`, передаём ради паритета с исходной командой).

`--print` / `-p` — печать `docker exec`-команды в stdout + clipboard, без выполнения.
"""

import subprocess
from typing import Annotated

import typer

from mpu.lib.cli_wrap import auto_pick_int, require, resolve_selector
from mpu.lib.clipboard import copy_to_clipboard

COMMAND_NAME = "mpu make-schema"

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
        str | None,
        typer.Option("--server", help="Контейнер sl-N (default sl-1)"),
    ] = None,
    print_mode: Annotated[
        bool,
        typer.Option("--print", "-p", help="Печатать docker-команду в stdout + clipboard"),
    ] = False,
    client_id: Annotated[
        int | None,
        typer.Option(
            "--client-id",
            "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
) -> None:
    """clientsMigrations init: создать схему клиента в локальном mp-sl-N-cli."""
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=False
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    # Контейнер по умолчанию sl-1 (как в исходной fish-функции); --server переопределяет.
    n = resolved.server_number if server is not None else 1
    container = f"mp-sl-{n}-cli"
    cmd = [
        "docker", "exec", container,
        "node", "cli", "service:clientsMigrations", "init",
        "--client-id", str(cid), "--server", f"sl-{n}",
    ]

    if print_mode:
        printable = " ".join(cmd)
        typer.echo(printable)
        copy_to_clipboard(printable)
        return

    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        raise typer.Exit(code=rc)
