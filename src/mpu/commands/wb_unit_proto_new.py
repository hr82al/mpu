"""`mpu wb-unit-proto-new copy-data-from-old-table` — миграция старой proto-таблицы в новую."""

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    emit_node_cli,
    pick_client_id,
    pick_wrapper,
    resolve_selector,
)

COMMAND_NAME = "mpu wb-unit-proto-new"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="copy-data-from-old-table")
def copy_data_from_old_table(
    value: SelectorArg,
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    client_id: ClientIdOpt = None,
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = pick_client_id(resolved, client_id, command_name=COMMAND_NAME)
    emit_node_cli(
        name="wbUnitProtoNew",
        method="copyDataFromOldTable",
        flags={"--client-id": cid},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
