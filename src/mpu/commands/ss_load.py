"""`mpu ss-load` — ssh+docker команда для service:ssLoader load.

Note: `--sheet-name` принимает только ASCII-строки без шелл-спецсимволов. Для русских
имён листов вроде "Раздачи" — проще отредактировать вывод вручную после copy-paste.
"""

from typing import Annotated

import typer

from mpu.lib.cli_opts import (
    ClientIdOpt,
    LocalOpt,
    PrintOpt,
    SelectorArg,
    ServerOpt,
    SpreadsheetIdOpt,
)
from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_int,
    auto_pick_str,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu ss-load"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(  # noqa: PLR0913
    value: SelectorArg,
    dataset: Annotated[str, typer.Option("--dataset", help="Dataset name (required)")],
    server: ServerOpt = None,
    local: LocalOpt = False,
    print_mode: PrintOpt = False,
    client_id: ClientIdOpt = None,
    spreadsheet_id: SpreadsheetIdOpt = None,
    sheet_name: Annotated[
        str | None,
        typer.Option("--sheet-name", "--sheet_name", help="Sheet name (ASCII без spaces)"),
    ] = None,
    forced: Annotated[bool, typer.Option("--forced", help="Принудительная перезагрузка")] = False,
    logs: Annotated[str, typer.Option("--logs", help="Logs level: info, debug, ...")] = "info",
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
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
        "--dataset": dataset,
        "--client-id": cid,
        "--spreadsheet-id": ssid,
        "--sheet-name": sheet_name,
        "--forced": forced,
        "--logs": logs,
    }
    emit_node_cli(
        name="ssLoader",
        method="load",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
