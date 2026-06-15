"""Спецификация и docker-обёртки core-стеков локального dev-окружения (`mp-config-local`).

`mpu mp-init` поднимает минимально достаточный SL backend: NATS, main (`sl-0`), один
instance (`sl-1`), nginx и dt-host — каждый со ВСЕМИ своими сервисами через
`docker compose ... up -d --force-recreate`. Здесь — декларативная спека стеков
(env-файлы + compose-файлы + профили), сборка argv и тонкие обёртки над docker для
проверки сети и локально собранных образов. Оркестрация (порядок, вывод, fail-fast) —
в команде `mpu.commands.mp_init`.

Каталог `mp-config-local` резолвится через `dt_host.mp_config_local_dir()` (override
env `MPU_MP_CONFIG_LOCAL`). Источник истины по инвокациям — `mp-config-local/aliases.d/*`
(сверено: `30-mp-nats.sh`, `40-sl-back.sh`, `80-mp-nginx.sh`, `42-sl-dt.sh`).
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path

# Общая сеть проекта (one-time setup из readme mp-config-local).
SHARED_NET = "mp-shared-net"
SHARED_NET_SUBNET = "178.20.0.0/16"

# Опциональный env-файл: gitignored, может отсутствовать (readme). Включаем в argv
# только если существует — иначе `docker compose --env-file <missing>` падает.
OPTIONAL_ENV = ".env"


@dataclass(frozen=True, slots=True)
class Stack:
    """Один docker-compose стек: какие env/compose файлы и профили подаются в `up`.

    `name` — отображаемое имя (как алиас: `sl-0`, `dt-host`). `env_files` / `compose_files`
    — имена файлов внутри каталога mp-config-local в порядке передачи (поздние env
    переопределяют ранние). `profiles` — значения `--profile` (для core-стеков пусто).
    """

    name: str
    env_files: tuple[str, ...]
    compose_files: tuple[str, ...]
    profiles: tuple[str, ...] = ()


# Core SL backend. Порядок кортежа = порядок запуска:
# nats → main → instance → nginx → dt-host (listeners требуют nats; instance после main;
# nginx зависит от shared-net + .shared.env; dt-host независим / host-net).
CORE_STACKS: tuple[Stack, ...] = (
    Stack(
        name="mp-nats",
        env_files=(".sl-base.env", OPTIONAL_ENV),
        compose_files=("compose.mp-nats.yaml",),
    ),
    Stack(
        name="sl-0",
        env_files=(".sl-base.env", OPTIONAL_ENV, ".sl-0.env"),
        compose_files=(
            "compose.sl-base.yaml",
            "compose.sl-pg.yaml",
            "compose.sl-main.yaml",
        ),
    ),
    Stack(
        name="sl-1",
        env_files=(".sl-base.env", OPTIONAL_ENV, ".sl-1.env"),
        compose_files=(
            "compose.sl-base.yaml",
            "compose.sl-pg.yaml",
            "compose.pgbouncer.yaml",
            "compose.sl-instance.yaml",
        ),
    ),
    Stack(
        name="mp-nginx",
        env_files=(".shared.env", OPTIONAL_ENV),
        compose_files=("compose.mp-nginx.yaml",),
    ),
    Stack(
        name="dt-host",
        env_files=(".sl-base.env", ".sl-dt.env", OPTIONAL_ENV),
        compose_files=("compose.sl-dt-host.yaml",),
    ),
)

# Локально собираемые образы, которые используют core-стеки по `image:` (mp-back/mp-dt —
# без `build:` фолбэка; mp-pg имеет fallback, но собирать молча на `up` не хотим).
# image → build-алиас mp-config-local (подсказка пользователю).
REQUIRED_LOCAL_IMAGES: dict[str, str] = {
    "mp-back:local": "sl-build-image",
    "mp-pg:local": "mp-pg-build-image",
    "mp-dt:local": "mp-dt-build-image",
}


def build_up_argv(stack: Stack, base: Path) -> list[str]:
    """Собрать argv `docker compose ... up -d --force-recreate` для стека.

    Env- и compose-файлы подаются абсолютными путями (под `base`). Опциональный `.env`
    включается только если существует на диске. БЕЗ фильтра сервисов → поднимаются ВСЕ
    сервисы стека (в т.ч. простаивающие `cli` / `migrations`). БЕЗ `--remove-orphans` —
    иначе снесёт контейнеры соседних стеков того же compose-проекта.
    """
    argv = ["docker", "compose"]
    for env in stack.env_files:
        if env == OPTIONAL_ENV and not (base / env).is_file():
            continue
        argv += ["--env-file", str(base / env)]
    for compose in stack.compose_files:
        argv += ["-f", str(base / compose)]
    for profile in stack.profiles:
        argv += ["--profile", profile]
    argv += ["up", "-d", "--force-recreate"]
    return argv


def network_create_argv(name: str, subnet: str) -> list[str]:
    """argv создания bridge-сети (как в readme: `--driver=bridge ... --subnet=...`)."""
    return ["docker", "network", "create", "--driver=bridge", name, f"--subnet={subnet}"]


def network_exists(name: str) -> bool:
    """True если docker-сеть `name` существует (`docker network inspect`)."""
    return _quiet_rc(["docker", "network", "inspect", name]) == 0


def create_network(name: str, subnet: str) -> int:
    """Создать bridge-сеть `name` с `subnet`. Вернуть returncode docker."""
    return subprocess.run(network_create_argv(name, subnet), check=False).returncode


def image_exists(ref: str) -> bool:
    """True если локальный docker-образ `ref` существует (`docker image inspect`)."""
    return _quiet_rc(["docker", "image", "inspect", ref]) == 0


def missing_images() -> list[str]:
    """`:local`-образы из REQUIRED_LOCAL_IMAGES, которых нет локально (в порядке спеки)."""
    return [ref for ref in REQUIRED_LOCAL_IMAGES if not image_exists(ref)]


def _quiet_rc(argv: list[str]) -> int:
    """Прогнать `argv`, подавив stdout/stderr, вернуть returncode (для probe-команд)."""
    return subprocess.run(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode
