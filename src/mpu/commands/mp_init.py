"""`mpu mp-init` — поднять локальный dev-стек (mp-config-local) целиком.

Одной командой приводит локальное окружение в рабочее состояние: создаёт сеть
`mp-shared-net` (если её нет), проверяет наличие локально собранных образов и поднимает
core SL backend — `mp-nats`, `sl-0` (main), `sl-1` (instance), `mp-nginx`, `dt-host` —
каждый со ВСЕМИ сервисами через `docker compose ... up -d --force-recreate`. Затем поверх
core поднимает always-on web-стек: БД-зависимости sw-back (pg+redis) и `mp/local-stack`
(sw-front + sw-back + sl-front, `up -d --force-recreate`), предварительно погасив
конфликтующие контейнеры mp-config-local (mp-sw-api / nextjs-dev / mp-sl-front-dev).

Зачем: helper-контейнеры `cli` (`mp-sl-N-cli`) и `dt-host-cli` — простаивающие
(`command: tail -f /dev/null`) и ни от чего не `depends_on`, поэтому частичный `up`
listeners/workers их не создаёт. Из-за этого падают `mpu make-schema` (нет `mp-sl-1-cli`)
и `mpu copy-client` (нет `dt-host-cli`). `mp-init` поднимает весь core гарантированно;
`--force-recreate` пересоздаёт контейнеры под изменения compose/образов.

Образы НЕ собираются: при отсутствии `mp-back:local` / `mp-pg:local` / `mp-dt:local`
команда останавливается с подсказкой на build-алиас mp-config-local; отсутствие web-образа
`sl-front-dev:local` — только warning (остальной стек поднимается).

`--dry-run` / `-n` — напечатать docker-команды (network + up) без выполнения.

Каталог mp-config-local: по умолчанию `~/mr/mp/mp-config-local`, override через env
`MPU_MP_CONFIG_LOCAL`. Каталог web-стека — sibling `mp/local-stack`; отсутствует → web
пропускается (core уже поднят).
"""

import shlex
import subprocess
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import dt_host, mp_stack

COMMAND_NAME = "mpu mp-init"
COMMAND_SUMMARY = (
    "Поднять локальный dev-стек: сеть + core (nats/sl-0/sl-1/nginx/dt-host) + "
    "web (sw-front/sw-back/sl-front) через up -d --force-recreate"
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
    """Создать сеть (если нет), поднять core SL backend + web-стек (up -d --force-recreate)."""
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

    web_ran = _bring_up_web(base, dry_run=dry_run)

    if dry_run:
        typer.echo("dry-run: ничего не выполнено", err=True)
    elif web_ran:
        typer.echo(
            "mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) + web (sw-front/sw-back/sl-front)",
            err=True,
        )
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


def _bring_up_web(base: Path, *, dry_run: bool) -> bool:
    """Поднять always-on web-стек поверх core. Вернуть True, если стек поднимался.

    Шаги: (1) БД-зависимости sw-back (pg+redis из compose.sw-back.yaml — тем же
    --env-file/compose/cwd, что `sw-back-up`); (2) стоп конфликтующих контейнеров
    mp-config-local (mp-sw-api/nextjs-dev/mp-sl-front-dev) — иначе local-stack `up`
    упрётся в занятые порты/алиасы; (3) `mp/local-stack` (sw-front+sw-back+sl-front)
    через `up -d --force-recreate`. Каталог local-stack отсутствует → web пропущен
    (core уже поднят), возврат False. Любой `up` с rc!=0 → fail-fast (typer.Exit).
    """
    stack_dir = mp_stack.local_stack_dir(base)
    if not stack_dir.is_dir():
        typer.echo(
            f"{COMMAND_NAME}: каталог local-stack не найден: {stack_dir}; web-стек пропущен",
            err=True,
        )
        return False

    missing = mp_stack.missing_web_images()
    if missing:
        hints = "; ".join(f"{ref} → {mp_stack.WEB_REQUIRED_IMAGES[ref]}" for ref in missing)
        typer.echo(f"warning: нет web-образов: {hints}", err=True)

    # 1. sw-back БД-зависимости (pg + redis).
    deps_argv = mp_stack.build_up_argv(mp_stack.SW_BACK_DEPS, base)
    typer.echo(f"$ {shlex.join(deps_argv)}", err=True)
    if not dry_run:
        rc = subprocess.run(deps_argv, check=False, cwd=base).returncode
        if rc != 0:
            typer.echo(f"{COMMAND_NAME}: sw-back-deps упал (rc={rc})", err=True)
            raise typer.Exit(code=rc)

    # 2. Стоп конфликтующих контейнеров mp-config-local.
    if dry_run:
        stop_argv = mp_stack.stop_containers_argv(list(mp_stack.LOCAL_STACK_CONFLICTS))
        typer.echo(f"$ {shlex.join(stop_argv)}  # только запущенные", err=True)
    else:
        conflicts = mp_stack.running_conflicts(mp_stack.LOCAL_STACK_CONFLICTS)
        if conflicts:
            stop_argv = mp_stack.stop_containers_argv(conflicts)
            typer.echo(f"$ {shlex.join(stop_argv)}", err=True)
            subprocess.run(stop_argv, check=False)

    # 3. local-stack: sw-front + sw-back + sl-front (up -d --force-recreate).
    web_argv = mp_stack.build_local_stack_up_argv(stack_dir)
    typer.echo(f"$ {shlex.join(web_argv)}", err=True)
    if not dry_run:
        rc = subprocess.run(web_argv, check=False, cwd=stack_dir).returncode
        if rc != 0:
            typer.echo(f"{COMMAND_NAME}: local-stack упал (rc={rc})", err=True)
            raise typer.Exit(code=rc)

    return True
