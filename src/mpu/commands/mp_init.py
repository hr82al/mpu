"""`mpu mp-init` — поднять полный локальный стек: sl-0 (main) + sl-1 (instance) + sw-back.

Идемпотентно. Порядок: сеть `mp-shared-net` → `mp-nats` → sl-0 (`compose.sl-{base,pg,main}`) →
sl-1 (`compose.sl-{base,pg}` + `pgbouncer` + `sl-instance`) → `appMigrations latest` на обоих →
sw-back. Env-цепочка и compose-файлы зеркалят docker-compose алиасы из
`mp-config-local/aliases.d/40-sl-back.sh` (`.sl-N.env` грузится последним, чтобы выиграть
интерполяцию `${SERVER_NAME}` в compose-файлах).

Per-client и dataset-миграции применяются автоматически в startup-sweep'е контейнера
`i-clients-migrations` (он self-heal'ит схемы с поехавшим OWNER — напр. после copy-client/restore,
и пропускает отдельный сбойный клиент, не роняя весь контейнер). Публичные `appMigrations`
(public: clients/spreadsheets/…) гоняем явно после готовности PG.

`--force-recreate` — пересоздать контейнеры (после правок compose/env или чтобы сбросить
застрявший стек, напр. крашлупящий `i-clients-migrations`). `--no-build` — не пересобирать образ
sw api. sl-back использует готовый образ `mp-back:local` (собрать: `sl-build-image`).
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import dt_host

COMMAND_NAME = "mpu mp-init"
COMMAND_SUMMARY = "Поднять полный локальный стек sl-0 + sl-1 + sw-back (docker compose) + миграции"

SHARED_NET = "mp-shared-net"
SHARED_NET_SUBNET = "178.20.0.0/16"
SL_BACK_IMAGE = "mp-back:local"
PG_READY_ATTEMPTS = 60

# Per-server (env-file chain, compose-file set) — зеркало sl-0 / sl-N алиасов в
# mp-config-local/aliases.d/40-sl-back.sh. `.sl-N.env` (SERVER_NAME / SERVER_NUMBER) грузится
# последним → выигрывает интерполяцию `${SERVER_NAME}` в compose-файлах.
SL_SERVERS: list[tuple[str, list[str], list[str]]] = [
    (
        "sl-0",
        [".sl-base.env", ".env", ".sl-0.env"],
        ["compose.sl-base.yaml", "compose.sl-pg.yaml", "compose.sl-main.yaml"],
    ),
    (
        "sl-1",
        [".sl-base.env", ".env", ".sl-1.env"],
        [
            "compose.sl-base.yaml",
            "compose.sl-pg.yaml",
            "compose.pgbouncer.yaml",
            "compose.sl-instance.yaml",
        ],
    ),
]

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


def _ensure_sl_image() -> None:
    if _run(["docker", "image", "inspect", SL_BACK_IMAGE], capture=True).returncode == 0:
        return
    typer.echo(
        f"{COMMAND_NAME}: образ {SL_BACK_IMAGE} не найден; собери его: `sl-build-image`",
        err=True,
    )
    raise typer.Exit(code=2)


def _compose_up(
    base: Path,
    env_files: list[str],
    compose_files: list[str],
    *,
    build: bool,
    force_recreate: bool,
) -> None:
    argv = ["docker", "compose"]
    for e in env_files:
        if (base / e).is_file():  # .env gitignored — может отсутствовать
            argv += ["--env-file", str(base / e)]
    for cf in compose_files:
        argv += ["-f", str(base / cf)]
    argv += ["up", "-d"]
    if build:
        argv.append("--build")
    if force_recreate:
        argv.append("--force-recreate")
    rc = _run(argv).returncode
    if rc != 0:
        typer.echo(
            f"{COMMAND_NAME}: docker compose up ({', '.join(compose_files)}) failed (exit {rc})",
            err=True,
        )
        raise typer.Exit(code=1)


def _wait_pg_ready(server: str, *, attempts: int = PG_READY_ATTEMPTS) -> None:
    pg = f"mp-{server}-pg"
    for _ in range(attempts):
        rc = _run(
            ["docker", "exec", pg, "pg_isready", "-U", "wb_plus_db_admin", "-d", "wb"],
            capture=True,
        ).returncode
        if rc == 0:
            return
        time.sleep(1)
    typer.echo(
        f"⚠ {COMMAND_NAME}: {pg} не готов за {attempts}s — миграции для {server} могут упасть",
        err=True,
    )


def _run_app_migrations(server: str) -> None:
    cli = f"mp-{server}-cli"
    argv = ["docker", "exec", cli, "node", "cli", "service:appMigrations", "latest"]
    if _run(argv).returncode != 0:
        typer.echo(f"{COMMAND_NAME}: appMigrations latest failed on {server}", err=True)
        raise typer.Exit(code=1)


@app.command()
def main(
    force_recreate: Annotated[
        bool,
        typer.Option("--force-recreate", help="Пересоздать контейнеры (после правок compose/env)"),
    ] = False,
    no_build: Annotated[
        bool, typer.Option("--no-build", help="Не пересобирать образ sw api")
    ] = False,
) -> None:
    """Поднять полный локальный стек sl-0 + sl-1 + sw-back и применить миграции."""
    base = dt_host.mp_config_local_dir()
    if not base.is_dir():
        typer.echo(f"{COMMAND_NAME}: mp-config-local не найден: {base}", err=True)
        raise typer.Exit(code=2)

    _ensure_network()
    _ensure_sl_image()

    # NATS — общая шина sl ↔ sw.
    _compose_up(
        base,
        [".sl-base.env", ".env"],
        ["compose.mp-nats.yaml"],
        build=False,
        force_recreate=force_recreate,
    )

    # sl-0 (main) + sl-1 (instance) — полные стеки. i-clients-migrations поднимется здесь и
    # сам прогонит per-client миграции (self-heal). На совсем пустой БД он переждёт пару рестартов,
    # пока ниже не докатятся appMigrations (public.clients).
    for _server, env_files, compose_files in SL_SERVERS:
        _compose_up(base, env_files, compose_files, build=False, force_recreate=force_recreate)

    # Публичные миграции (clients/spreadsheets/…) — явно, после готовности PG каждого сервера.
    for server, _env, _files in SL_SERVERS:
        _wait_pg_ready(server)
        _run_app_migrations(server)

    # sw-back (NestJS api + pg + redis).
    _compose_up(
        base,
        [".sw-back.base.env"],
        ["compose.sw-back.yaml"],
        build=not no_build,
        force_recreate=force_recreate,
    )

    typer.echo(
        "✓ стек поднят (sl-0 + sl-1 + sw-back), appMigrations применены. "
        "Создать схему клиента: `mpu make-schema <client_id>`. "
        "Данные с dev: `mpu copy-dev` / `mpu copy-dev <client_id>`. API: http://localhost:3000/api"
    )
