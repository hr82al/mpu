"""`mpu wb-jobs <method>` — обёртки node cli
service:wbJobs (exec через Portainer; `--print` — печать)."""

import typer

from mpu.lib.factories import jobs_show

COMMAND_NAME = "mpu wb-jobs"
COMMAND_SUMMARY = "Обёртки service:wbJobs (exec через Portainer)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Обёртки над `node cli service:wbJobs` (sl-back). Дефолт — немедленное "
        "выполнение метода в проде через Portainer; `--print`/`-p` — печать команды."
    ),
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Force group-mode: typer схлопывает в flat-app при единственном subcommand'е."""


jobs_show.register(
    app=app,
    service="wbJobs",
    methods=[("show", "showJobs")],
    command_name=COMMAND_NAME,
)
