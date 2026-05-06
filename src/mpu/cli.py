"""mpu — top-level Typer CLI. Subcommands are added via `app.add_typer(...)`."""

import typer

from mpu import __version__

app = typer.Typer(
    name="mpu",
    help="Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.",
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Удерживает multi-command структуру: без callback typer схлопывает single command в root."""


@app.command(name="version")
def version_cmd() -> None:
    """Show mpu version."""
    typer.echo(__version__)
