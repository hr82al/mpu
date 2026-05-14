"""Passthrough wrapper для `new-mpu sheet`. Будет заменён нативной реализацией."""

from __future__ import annotations

import typer

from mpu.lib.new_mpu import run_new_mpu

_PASSTHROUGH_CTX: dict[str, object] = {
    "allow_extra_args": True,
    "ignore_unknown_options": True,
    "help_option_names": [],
}

app = typer.Typer(
    name="sheet",
    help="Google Spreadsheets (proxy to `new-mpu sheet`).",
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CTX,
)


@app.command(name="main", context_settings=_PASSTHROUGH_CTX)
def main(ctx: typer.Context) -> None:
    """All arguments are passed verbatim to `new-mpu sheet`."""
    raise typer.Exit(code=run_new_mpu("sheet", ctx.args))
