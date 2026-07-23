"""`mpu data-loader <method>` — печать ssh+docker команд для service:dataLoader."""

from typing import Annotated

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_int,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu data-loader"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


@app.command(name="find-candidate")
def find_candidate(
    value: SelectorArg,
    sids: Annotated[
        list[str],
        typer.Option("--sids", "--sid", help="WB cabinet sid(s); flag можно повторять"),
    ],
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
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    flags: dict[str, FlagValue] = {"--client-id": cid, "--sids": sids}
    emit_node_cli(
        name="dataLoader",
        method="findCandidate",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
