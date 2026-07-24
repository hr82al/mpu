"""`mpu datasets-migrations <method>` — обёртки node cli
service:datasetsMigrations (exec через Portainer; `--print` — печать)."""

import typer

from mpu.lib.factories import migrations_with_dataset

COMMAND_NAME = "mpu datasets-migrations"
COMMAND_SUMMARY = "Обёртки service:datasetsMigrations (exec через Portainer)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Обёртки над `node cli service:datasetsMigrations` (sl-back). Дефолт — немедленное "
        "выполнение метода в проде через Portainer; `--print`/`-p` — печать команды."
    ),
)

migrations_with_dataset.register(
    app=app,
    service="datasetsMigrations",
    methods=[
        ("latest", "latest"),
        ("up", "up"),
        ("rollback", "rollback"),
        ("down", "down"),
        ("list", "list"),
    ],
    command_name=COMMAND_NAME,
)
