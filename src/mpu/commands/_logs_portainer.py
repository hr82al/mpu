"""Portainer-backend для `mpu-logs --via portainer` — `docker logs --tail`.

Извлечён без изменений поведения из старой `commands/logs.py`. Используется как
fallback, когда нужен свежий snapshot конкретного контейнера на конкретном sl-N
(например, отладка сразу после деплоя).
"""

import sys

import httpx
import typer

from mpu.commands._portainer_resolve import PortainerResolved, resolve_portainer
from mpu.lib.duration import DurationParseError, parse_since


def run(
    *,
    command_name: str,
    selector: str,
    container: str,
    tail: int,
    since: str | None,
    timestamps: bool,
    no_stdout: bool,
    no_stderr: bool,
) -> None:
    """Tail-логи контейнера на sl-N через Portainer Docker API."""
    pr = resolve_portainer(selector=selector, command_name=command_name)
    name = _resolve_container_name(pr, container, command_name=command_name)
    since_ts = _since_or_exit(since, command_name=command_name)
    try:
        out, err = pr.client.container_logs(
            name,
            tail=tail,
            since=since_ts,
            timestamps=timestamps,
            stdout=not no_stdout,
            stderr=not no_stderr,
        )
    except httpx.HTTPError as e:
        typer.echo(f"{command_name}: portainer error: {e}", err=True)
        raise typer.Exit(code=1) from None

    if not no_stdout and out:
        sys.stdout.buffer.write(out)
        sys.stdout.buffer.flush()
    if not no_stderr and err:
        sys.stderr.buffer.write(err)
        sys.stderr.buffer.flush()


def _resolve_container_name(pr: PortainerResolved, query: str, *, command_name: str) -> str:
    """Точное имя или однозначная подстрока. На неоднозначность — typer.Exit(2)."""
    items = pr.client.list_containers(pr.endpoint_id)
    names: list[str] = []
    for it in items:
        ns = it.get("Names")
        if isinstance(ns, list):
            for n_raw in ns:  # type: ignore[reportUnknownVariableType]
                if isinstance(n_raw, str):
                    names.append(n_raw.lstrip("/"))
    exact = [n for n in names if n == query]
    if exact:
        return exact[0]
    matches = [n for n in names if query in n]
    sl = f"sl-{pr.server_number}"
    if not matches:
        typer.echo(f"{command_name}: контейнер {query!r} не найден на {sl}", err=True)
        typer.echo(f"  подсказка: mpup-ps {sl}", err=True)
        raise typer.Exit(code=2)
    if len(matches) > 1:
        typer.echo(
            f"{command_name}: подстрока {query!r} даёт несколько контейнеров на {sl}:",
            err=True,
        )
        for n in sorted(matches):
            typer.echo(f"  {n}", err=True)
        raise typer.Exit(code=2)
    return matches[0]


def _since_or_exit(s: str | None, *, command_name: str) -> int | None:
    if s is None:
        return None
    try:
        return parse_since(s)
    except DurationParseError as e:
        typer.echo(f"{command_name}: --since: {e}", err=True)
        raise typer.Exit(code=2) from None
