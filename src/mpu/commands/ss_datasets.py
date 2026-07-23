"""`mpu ss-datasets <method>` — печать ssh+docker команд для service:ssDatasets."""

from typing import Annotated

import typer

from mpu.lib.cli_opts import LocalOpt, PrintOpt, SelectorArg, ServerOpt, SpreadsheetIdOpt
from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_str,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu ss-datasets"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="add")
def add(
    value: SelectorArg,
    dataset: Annotated[str, typer.Option("--dataset", help="Dataset name (required)")],
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    spreadsheet_id: SpreadsheetIdOpt = None,
    sheet_name: Annotated[
        str | None,
        typer.Option("--sheet-name", "--sheet_name", help="Sheet name (ASCII без spaces)"),
    ] = None,
    is_active: Annotated[
        bool | None,
        typer.Option("--is-active/--no-is-active", help="is_active flag (опц.)"),
    ] = None,
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    ssid = require(
        spreadsheet_id
        if spreadsheet_id is not None
        else auto_pick_str(resolved.candidates, "spreadsheet_id"),
        flag="--spreadsheet-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    flags: dict[str, FlagValue] = {
        "--spreadsheet-id": ssid,
        "--dataset": dataset,
        "--sheet-name": sheet_name,
        "--is-active": is_active,
    }
    emit_node_cli(
        name="ssDatasets",
        method="add",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
