"""Спецификация и docker-обёртки core-стеков локального dev-окружения (`mp-config-local`).

`mpu mp-init` поднимает минимально достаточный SL backend: NATS, main (`sl-0`), один
instance (`sl-1`), nginx и dt-host — каждый со ВСЕМИ своими сервисами через
`docker compose ... up -d --force-recreate`, а затем поверх него always-on web-стек
(sw-back pg+redis + `mp/local-stack`). Здесь — декларативная спека стеков (env-файлы +
compose-файлы + профили), сборка argv и тонкие обёртки над docker для проверки сети,
локально собранных образов и запущенных контейнеров. Оркестрация (порядок, вывод,
fail-fast) — в команде `mpu.commands.mp_init`.

Каталог `mp-config-local` резолвится через `dt_host.mp_config_local_dir()` (override
env `MPU_MP_CONFIG_LOCAL`). Источник истины по инвокациям — `mp-config-local/aliases.d/*`
(сверено: `30-mp-nats.sh`, `40-sl-back.sh`, `43-sw.sh`, `80-mp-nginx.sh`, `42-sl-dt.sh`).
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
    `services` — фильтр сервисов для `up` (пусто = все сервисы стека).
    """

    name: str
    env_files: tuple[str, ...]
    compose_files: tuple[str, ...]
    profiles: tuple[str, ...] = ()
    services: tuple[str, ...] = ()


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

# --- Web-стек (always-on sw-front/sw-back/sl-front) поверх core ----------------------------
# sw-back нужны его БД-зависимости из compose.sw-back.yaml — поднимаем ТОЛЬКО pg+redis (api
# заменяет always-on контейнер sw-back-dev из local-stack). Тот же --env-file/compose/cwd,
# что у алиаса `sw-back-up` (см. `aliases.d/43-sw.sh`) → тот же compose-проект
# (`mp-config-local`, т.к. .sw-back.base.env не задаёт COMPOSE_PROJECT_NAME) и сеть
# `mp-config-local_ws_default` с контейнерами mp-sw-pg / redis-dev.
SW_BACK_DEPS: Stack = Stack(
    name="sw-back-deps",
    env_files=(".sw-back.base.env",),
    compose_files=("compose.sw-back.yaml",),
    services=("pg", "redis"),
)

# Папка автономного always-on стека (sw-front + sw-back + sl-front) — sibling mp-config-local
# (mp/local-stack). Свой compose с `name: local-stack` и внешними сетями.
LOCAL_STACK_SUBDIR = "local-stack"
LOCAL_STACK_COMPOSE = "docker-compose.yml"

# Контейнеры mp-config-local, конфликтующие с local-stack по сетевым алиасам и портам
# (sw-front/sw-back/mp-sl-front-dev; порты 3000/3001/3002/9229/9262) → стоп перед `up`.
LOCAL_STACK_CONFLICTS: tuple[str, ...] = ("mp-sw-api", "nextjs-dev", "mp-sl-front-dev")

# Build-time образ sl-front: у sl-front нет своего dev-Dockerfile, образ собирается в
# mp-config-local. sw-front-local/sw-back-local собираются самим local-stack (есть `build:`).
WEB_REQUIRED_IMAGES: dict[str, str] = {
    "sl-front-dev:local": "sl-front-build-dev-image",
}


def build_up_argv(stack: Stack, base: Path) -> list[str]:
    """Собрать argv `docker compose ... up -d --force-recreate` для стека.

    Env- и compose-файлы подаются абсолютными путями (под `base`). Опциональный `.env`
    включается только если существует на диске. Без `stack.services` → ВСЕ сервисы стека
    (в т.ч. простаивающие `cli` / `migrations`); с фильтром — только указанные. БЕЗ
    `--remove-orphans` — иначе снесёт контейнеры соседних стеков того же compose-проекта.
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
    argv += list(stack.services)
    return argv


def local_stack_dir(base: Path) -> Path:
    """Каталог автономного web-стека `mp/local-stack` (sibling каталога mp-config-local)."""
    return base.parent / LOCAL_STACK_SUBDIR


def build_local_stack_up_argv(stack_dir: Path) -> list[str]:
    """argv `docker compose -f <local-stack>/docker-compose.yml up -d --force-recreate`."""
    return [
        "docker",
        "compose",
        "-f",
        str(stack_dir / LOCAL_STACK_COMPOSE),
        "up",
        "-d",
        "--force-recreate",
    ]


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


def missing_web_images() -> list[str]:
    """Web build-time образы из WEB_REQUIRED_IMAGES, которых нет локально (в порядке спеки)."""
    return [ref for ref in WEB_REQUIRED_IMAGES if not image_exists(ref)]


def container_running(name: str) -> bool:
    """True если контейнер `name` существует и в состоянии running."""
    proc = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
        text=True,
    )
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def running_conflicts(names: tuple[str, ...]) -> list[str]:
    """Подмножество `names`, которые сейчас запущены (для точечного `docker stop`)."""
    return [name for name in names if container_running(name)]


def stop_containers_argv(names: list[str]) -> list[str]:
    """argv `docker stop <names...>`."""
    return ["docker", "stop", *names]


def _quiet_rc(argv: list[str]) -> int:
    """Прогнать `argv`, подавив stdout/stderr, вернуть returncode (для probe-команд)."""
    return subprocess.run(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode
