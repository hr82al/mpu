"""`mpu-help` — список доступных команд и справка по ним."""

import subprocess
from typing import Annotated

import typer

_COMMANDS: dict[str, str] = {
    "mpu-search": "Поиск клиента / spreadsheet в локальном кэше",
    "mpu-update": "Синхронизировать кэш клиентов из sl-back",
    "mpu-sql": "Выполнить SQL на удалённом PG по селектору",
    "mpu-backup-wb-unit-proto": "CTAS-бэкап wb_unit_proto в backups-схему",
    "mpu-backup-ozon-unit-proto": "CTAS-бэкап ozon_unit_proto в backups-схему",
    "mpu-help": "Список команд",
}


def _print_list() -> None:
    typer.echo("Available commands:\n")
    max_name_len = max(len(name) for name in _COMMANDS)
    for name, desc in _COMMANDS.items():
        padding = " " * (max_name_len - len(name) + 2)
        typer.echo(f"  {name}{padding}{desc}")
    typer.echo("\nRun `<command> --help` for detailed usage.")


app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    command: Annotated[
        str | None, typer.Argument(help="Команда для показа справки (опционально)")
    ] = None,
) -> None:
    """Список всех mpu команд с опциональной справкой."""
    if command is None:
        _print_list()
        return

    if command not in _COMMANDS:
        typer.echo(f"mpu-help: unknown command '{command}'", err=True)
        typer.echo(f"Known commands: {', '.join(_COMMANDS.keys())}", err=True)
        raise typer.Exit(code=2)

    result = subprocess.run([command, "--help"], text=False)
    raise typer.Exit(code=result.returncode)


def run() -> None:
    """Entry point для `mpu-help`."""
    app()
