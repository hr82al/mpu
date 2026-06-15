"""`mpu mp-init` — поднять локальный тестовый стек sw-back (docker compose).

Идемпотентно: сеть `mp-shared-net` → `mp-nats` → sw-back (pg/redis/api, `nest --watch`).
`--force-recreate` — пересоздать контейнеры (после правок compose/env). sl-back НЕ трогаем
(переиспользуем `mp-sl-1-*`); если инстансный internal-api не запущен — подсказываем алиас.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import dt_host

COMMAND_NAME = "mpu mp-init"
COMMAND_SUMMARY = "Поднять локальный тестовый стек sw-back (docker compose, --force-recreate)"

SHARED_NET = "mp-shared-net"
SHARED_NET_SUBNET = "178.20.0.0/16"
SL_INTERNAL_API_CONTAINER = "mp-sl-1-i-internal-api"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _run(argv: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    typer.echo(f"$ {' '.join(argv)}", err=True)
    return subprocess.run(argv, check=False, capture_output=capture, text=True)


def _ensure_network() -> None:
    if _run(["docker", "network", "inspect", SHARED_NET], capture=True).returncode == 0:
        return
    create = ["docker", "network", "create", "--driver=bridge"]
    create += ["--subnet", SHARED_NET_SUBNET, SHARED_NET]
    if _run(create).returncode != 0:
        typer.echo(f"{COMMAND_NAME}: не удалось создать сеть {SHARED_NET}", err=True)
        raise typer.Exit(code=1)


def _compose_up(
    base: Path,
    env_files: list[str],
    compose_file: str,
    *,
    build: bool,
    force_recreate: bool,
) -> None:
    argv = ["docker", "compose"]
    for e in env_files:
        if (base / e).is_file():  # .env gitignored — может отсутствовать
            argv += ["--env-file", str(base / e)]
    argv += ["-f", str(base / compose_file), "up", "-d"]
    if build:
        argv.append("--build")
    if force_recreate:
        argv.append("--force-recreate")
    rc = _run(argv).returncode
    if rc != 0:
        typer.echo(f"{COMMAND_NAME}: docker compose up {compose_file} failed (exit {rc})", err=True)
        raise typer.Exit(code=1)


def _check_sl_internal_api() -> None:
    res = _run(
        ["docker", "ps", "--filter", f"name={SL_INTERNAL_API_CONTAINER}", "--format", "{{.Names}}"],
        capture=True,
    )
    if SL_INTERNAL_API_CONTAINER not in (res.stdout or ""):
        typer.echo(
            f"⚠ {SL_INTERNAL_API_CONTAINER} не запущен — sw-back не получит данные sl. "
            f"Подними локальный sl-1: `sl-1-up-b && sl-1-up-i`.",
            err=True,
        )


@app.command()
def main(
    force_recreate: Annotated[
        bool,
        typer.Option("--force-recreate", help="Пересоздать контейнеры (после правок compose/env)"),
    ] = False,
    no_build: Annotated[
        bool, typer.Option("--no-build", help="Не пересобирать образ api")
    ] = False,
) -> None:
    """Поднять локальный тестовый стек sw-back (сеть + mp-nats + sw-back)."""
    base = dt_host.mp_config_local_dir()
    if not base.is_dir():
        typer.echo(f"{COMMAND_NAME}: mp-config-local не найден: {base}", err=True)
        raise typer.Exit(code=2)

    _ensure_network()
    _compose_up(
        base, [".sl-base.env", ".env"], "compose.mp-nats.yaml",
        build=False, force_recreate=force_recreate,
    )
    _compose_up(
        base, [".sw-back.base.env"], "compose.sw-back.yaml",
        build=not no_build, force_recreate=force_recreate,
    )
    _check_sl_internal_api()

    typer.echo(
        "✓ стек sw-back поднят. Данные с dev: `mpu copy-dev` (workspaces) и "
        "`mpu copy-dev <client_id>` (sl-схема). API: http://localhost:3000/api"
    )
