"""`mpu app-migrations <method>` — обёртки node cli
service:appMigrations (exec через Portainer; `--print` — печать)."""

import typer

from mpu.lib.factories import migrations_app

COMMAND_NAME = "mpu app-migrations"
COMMAND_SUMMARY = "Обёртки service:appMigrations (exec через Portainer)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Обёртки над `node cli service:appMigrations` (sl-back). Дефолт — немедленное "
        "выполнение метода в проде через Portainer; `--print`/`-p` — печать команды."
    ),
)

migrations_app.register(
    app=app,
    service="appMigrations",
    methods=[
        ("latest", "latest"),
        ("up", "up"),
    ],
    command_name=COMMAND_NAME,
)
