"""`mpu ozon-jobs <method>` — обёртки node cli
service:ozonJobs (exec через Portainer; `--print` — печать)."""

import typer

from mpu.lib.factories import jobs_show

COMMAND_NAME = "mpu ozon-jobs"
COMMAND_SUMMARY = "Обёртки service:ozonJobs (exec через Portainer)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Обёртки над `node cli service:ozonJobs` (sl-back). Дефолт — немедленное "
        "выполнение метода в проде через Portainer; `--print`/`-p` — печать команды."
    ),
)

jobs_show.register(
    app=app,
    service="ozonJobs",
    methods=[("show", "showJobs"), ("prune", "pruneJobs")],
    command_name=COMMAND_NAME,
)
