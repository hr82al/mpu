"""Запуск shell-команды в локальном `dt-host-cli` контейнере (compose.sl-dt-host.yaml).

Используется командами, которые гоняют `node ./src/clientsTransfer.js` /
`node ./src/pgDataTransfer.js` локально, с подключением к удалённому source-PG
и локальному target-PG (порт 5441). См. `mpu-copy-client`, `mpu-copy-shared`.

Каталог `mp-config-local` — по умолчанию `~/mr/mp/mp-config-local`, override
через env `MPU_MP_CONFIG_LOCAL`. Env-файлы (`.sl-base.env`, `.sl-dt.env`, `.env`)
и `compose.sl-dt-host.yaml` обязательны.
"""

import os
import shlex
import subprocess
import sys
from pathlib import Path

import typer

ENV_DIR = "MPU_MP_CONFIG_LOCAL"
_DEFAULT_DIR = Path.home() / "mr" / "mp" / "mp-config-local"


def mp_config_local_dir() -> Path:
    override = os.environ.get(ENV_DIR)
    return Path(override) if override else _DEFAULT_DIR


def build_compose_argv(inner: str) -> list[str]:
    """Собрать argv для `docker compose --env-file ... -f ... exec -it cli sh -c <inner>`."""
    base = mp_config_local_dir()
    return [
        "docker",
        "compose",
        "--env-file",
        str(base / ".sl-base.env"),
        "--env-file",
        str(base / ".sl-dt.env"),
        "--env-file",
        str(base / ".env"),
        "-f",
        str(base / "compose.sl-dt-host.yaml"),
        "exec",
        "-it",
        "cli",
        "sh",
        "-c",
        inner,
    ]


def exec_cli(inner: str, *, command_name: str) -> int:
    """Прогнать `inner` через `sh -c` в dt-host cli-контейнере.

    Стримит stdout/stderr/stdin в реальном времени (наследованные file descriptors).
    Возвращает exit code дочернего процесса.
    """
    base = mp_config_local_dir()
    if not base.is_dir():
        typer.echo(
            f"{command_name}: mp-config-local dir not found: {base} (override via {ENV_DIR}=...)",
            err=True,
        )
        raise typer.Exit(code=2)
    compose = base / "compose.sl-dt-host.yaml"
    if not compose.is_file():
        typer.echo(f"{command_name}: compose file not found: {compose}", err=True)
        raise typer.Exit(code=2)

    argv = build_compose_argv(inner)
    typer.echo(f"$ {shlex.join(argv)}", err=True)
    return subprocess.run(argv, check=False, stdin=sys.stdin).returncode
