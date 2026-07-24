"""`mpu ss-load` — обёртка node cli
service:ssLoader load (exec через Portainer; `--print` — печать).

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
    emit_node_cli,
    pick_client_id,
    pick_spreadsheet_id,
    pick_wrapper,
    resolve_selector,
)

COMMAND_NAME = "mpu ss-load"
COMMAND_SUMMARY = "service:ssLoader load (exec через Portainer)"

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
    cid = pick_client_id(resolved, client_id, command_name=COMMAND_NAME)
    ssid = pick_spreadsheet_id(resolved, spreadsheet_id, command_name=COMMAND_NAME)
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
