"""`mpu mp-init` — поднять core локального dev-стека (mp-config-local).

Одной командой приводит локальное окружение в рабочее состояние: создаёт сеть
`mp-shared-net` (если её нет), проверяет наличие локально собранных образов и поднимает
core SL backend — `mp-nats`, `sl-0` (main), `sl-1` (instance), `mp-nginx`, `dt-host` —
каждый со ВСЕМИ сервисами через `docker compose ... up -d --force-recreate`.

Зачем: helper-контейнеры `cli` (`mp-sl-N-cli`) и `dt-host-cli` — простаивающие
(`command: tail -f /dev/null`) и ни от чего не `depends_on`, поэтому частичный `up`
listeners/workers их не создаёт. Из-за этого падают `mpu make-schema` (нет `mp-sl-1-cli`)
и `mpu copy-client` (нет `dt-host-cli`). `mp-init` поднимает весь core гарантированно;
`--force-recreate` пересоздаёт контейнеры под изменения compose/образов.

Образы НЕ собираются: при отсутствии `mp-back:local` / `mp-pg:local` / `mp-dt:local`
команда останавливается с подсказкой на build-алиас mp-config-local.

`--dry-run` / `-n` — напечатать docker-команды (network + up) без выполнения.

Каталог mp-config-local: по умолчанию `~/mr/mp/mp-config-local`, override через env
`MPU_MP_CONFIG_LOCAL`.
"""

import shlex
import subprocess
from typing import Annotated

import typer

from mpu.lib import dt_host, mp_stack

COMMAND_NAME = "mpu mp-init"
COMMAND_SUMMARY = (
    "Поднять core локального dev-стека: сеть + nats/sl-0/sl-1/nginx/dt-host "
    "(up -d --force-recreate)"
)

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", "-n", help="Напечатать docker-команды без выполнения"),
    ] = False,
) -> None:
    """Создать mp-shared-net (если нет) и поднять core SL backend (up -d --force-recreate)."""
    base = dt_host.mp_config_local_dir()
    if not base.is_dir():
        typer.echo(
            f"{COMMAND_NAME}: каталог mp-config-local не найден: {base}; "
            f"попробуй: задай {dt_host.ENV_DIR}=<путь>",
            err=True,
        )
        raise typer.Exit(code=2)

    _ensure_network(dry_run=dry_run)
    _check_images(dry_run=dry_run)

    for stack in mp_stack.CORE_STACKS:
        argv = mp_stack.build_up_argv(stack, base)
        typer.echo(f"$ {shlex.join(argv)}", err=True)
        if dry_run:
            continue
        rc = subprocess.run(argv, check=False, cwd=base).returncode
        if rc != 0:
            typer.echo(
                f"{COMMAND_NAME}: стек '{stack.name}' упал (rc={rc}); остальные не поднимаю",
                err=True,
            )
            raise typer.Exit(code=rc)

    if dry_run:
        typer.echo("dry-run: ничего не выполнено", err=True)
    else:
        typer.echo("mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host", err=True)


def _ensure_network(*, dry_run: bool) -> None:
    """Создать mp-shared-net, если её нет. В dry-run — только напечатать команду."""
    if mp_stack.network_exists(mp_stack.SHARED_NET):
        return
    argv = mp_stack.network_create_argv(mp_stack.SHARED_NET, mp_stack.SHARED_NET_SUBNET)
    typer.echo(f"$ {shlex.join(argv)}", err=True)
    if dry_run:
        return
    rc = mp_stack.create_network(mp_stack.SHARED_NET, mp_stack.SHARED_NET_SUBNET)
    if rc != 0:
        typer.echo(
            f"{COMMAND_NAME}: не удалось создать сеть {mp_stack.SHARED_NET} (rc={rc})",
            err=True,
        )
        raise typer.Exit(code=rc)


def _check_images(*, dry_run: bool) -> None:
    """Проверить локально собранные образы. Отсутствуют → abort (в dry-run — warning)."""
    missing = mp_stack.missing_images()
    if not missing:
        return
    hints = "; ".join(f"{ref} → {mp_stack.REQUIRED_LOCAL_IMAGES[ref]}" for ref in missing)
    msg = (
        f"{COMMAND_NAME}: нет локальных образов: {hints}; "
        f"попробуй: собери их в mp-config-local указанными алиасами"
    )
    if dry_run:
        typer.echo(f"warning: {msg}", err=True)
        return
    typer.echo(msg, err=True)
    raise typer.Exit(code=1)
