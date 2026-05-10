"""Shared helper для команд `mpup-ps` / `mpup-logs` / `mpup-health`.

Резолв `selector → server_number → portainer.Client + endpoint_id` с единым
форматом ошибок (typer.Exit(2)) и шорт-циклом для прямого `sl-N`.
"""

from dataclasses import dataclass

import typer

from mpu.lib import portainer, servers
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server


@dataclass(frozen=True, slots=True)
class PortainerResolved:
    server_number: int
    client: portainer.Client
    endpoint_id: int


def resolve_portainer(*, selector: str, command_name: str) -> PortainerResolved:
    """Резолв селектора в Portainer Client. server_number > 0 (sl-0 не cli-таргет)."""
    try:
        n, candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None
    if n <= 0:
        typer.echo(f"{command_name}: ожидается sl-N (N>0), получено: {selector!r}", err=True)
        raise typer.Exit(code=2)
    _ = candidates  # подавить неиспользуемый возврат resolve_server

    target = servers.portainer_target(n)
    if target is None:
        typer.echo(
            f"{command_name}: для sl-{n} не найден portainer-target "
            f"(SQLite после `mpu init` или sl_{n}_portainer в ~/.config/mpu/.env)",
            err=True,
        )
        raise typer.Exit(code=2)
    api_key = servers.env_value("PORTAINER_API_KEY")
    if not api_key:
        typer.echo(f"{command_name}: PORTAINER_API_KEY не задан в ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)
    base_url, endpoint_id = target
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    client = portainer.Client(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        verify_tls=verify_tls,
    )
    return PortainerResolved(server_number=n, client=client, endpoint_id=endpoint_id)
