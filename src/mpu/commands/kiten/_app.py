"""Общий `typer.Typer` для `mpu kiten` — подмодули импортируют его отсюда и
декорируют свои команды (чтобы избежать циклов через пакетный `__init__`)."""

import typer

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)
