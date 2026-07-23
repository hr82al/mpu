"""Общий резолв селектора в таргет выполнения — для `mpu ssh` и `mpu run-js`.

Обе команды принимают один и тот же селектор и должны понимать его одинаково: раньше
логика была скопирована в оба модуля и успела разойтись (`sl-0` одна принимала, другая
отвергала). Источник истины теперь один.
"""

from dataclasses import dataclass

import typer

from mpu.lib import containers, servers
from mpu.lib.resolver import resolve_server_or_exit


@dataclass(frozen=True, slots=True)
class ServerTarget:
    """Сервер: команда пойдёт в `mp-sl-{server_number}-cli` (или на dev-ноду при `dev`)."""

    server_number: int
    dev: bool = False


@dataclass(frozen=True, slots=True)
class ContainerTarget:
    """Контейнер по точному имени из Portainer-кэша."""

    container: str


Target = ServerTarget | ContainerTarget


def server_ref(target: ServerTarget) -> str:
    """Селектор-ссылка на серверный таргет: `dev:N` для dev-ноды, иначе `sl-N`."""
    return f"dev:{target.server_number}" if target.dev else f"sl-{target.server_number}"


def target_label(target: Target) -> str:
    """Человекочитаемая метка таргета: `sl-N` / `dev:N` или точное имя контейнера."""
    return server_ref(target) if isinstance(target, ServerTarget) else target.container


def resolve_target(selector: str, *, command_name: str) -> Target:
    """Селектор → сервер (sl-N CLI) или контейнер по точному имени.

    Порядок:
      0. `dev:N` — sl-N на dev-ноде (`mp-dev`, ssh+docker) → `ServerTarget(N, dev=True)`.
      1. `sl-N` формат → `ServerTarget(N)`; `sl-0` — обычный main-сервер, не «нулевой».
      2. Точное имя контейнера в Portainer-кэше (1 совпадение) → `ContainerTarget(name)`.
      3. >1 совпадение по имени контейнера → ошибка с вариантами (без fallback в поиск,
         чтобы не маскировать опечатку легитимным client-селектором).
      4. Иначе — поиск по client_id / spreadsheet_id / title.
    """
    if (dev_rest := servers.parse_dev_selector(selector)) is not None:
        dev_number = servers.dev_server_number(dev_rest)
        if dev_number is None or dev_number < 0:
            typer.echo(
                f"{command_name}: dev-селектор ожидает номер sl-сервера: `dev:N` (например dev:1), "
                f"получено: {selector!r}",
                err=True,
            )
            raise typer.Exit(code=2)
        return ServerTarget(dev_number, dev=True)

    number = servers.server_number(selector)
    if number is not None:
        return _server_target(number, selector=selector, command_name=command_name)

    matches = containers.find_container_targets(selector)
    if len(matches) == 1:
        return ContainerTarget(selector)
    if len(matches) > 1:
        typer.echo(
            f"{command_name}: container {selector!r} ambiguous — "
            f"{len(matches)} Portainer endpoints:",
            err=True,
        )
        typer.echo(containers.format_container_candidates(matches), err=True)
        raise typer.Exit(code=2)

    resolved_number, _candidates = resolve_server_or_exit(selector, command_name=command_name)
    return _server_target(resolved_number, selector=selector, command_name=command_name)


def _server_target(number: int, *, selector: str, command_name: str) -> ServerTarget:
    if number < 0:
        typer.echo(f"{command_name}: ожидается sl-N (N>=0), получено: {selector!r}", err=True)
        raise typer.Exit(code=2)
    return ServerTarget(number)
