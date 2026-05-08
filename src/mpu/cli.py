"""mpu — top-level Typer CLI. Subcommands are added via `app.add_typer(...)`."""

from typing import Annotated

import typer

from mpu import __version__
from mpu.lib import portainer_discover, store

app = typer.Typer(
    name="mpu",
    help="Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.",
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Удерживает multi-command структуру: без callback typer схлопывает single command в root."""


@app.command(name="version")
def version_cmd() -> None:
    """Show mpu version."""
    typer.echo(__version__)


@app.command(name="init")
def init_cmd(
    portainer_url: Annotated[
        str | None,
        typer.Option(
            "--portainer",
            help="URL Portainer (override `PORTAINER_URL` из ~/.config/mpu/.env)",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Только напечатать summary, не писать в SQLite"),
    ] = False,
    reset: Annotated[
        bool,
        typer.Option("--reset", help="Перед записью почистить таблицу portainer_containers"),
    ] = False,
) -> None:
    """Discover все контейнеры через Portainer API и закэшировать в `~/.config/mpu/mpu.db`.

    Кэшируем все контейнеры, помечая `mp-sl-N-cli` через `server_number`. Этот кэш
    потом читает `mpup-ssh` для резолва Portainer-транспорта.
    """
    # Шаг 1: bootstrap SQLite-схемы (отсюда — всегда, других мест нет).
    with store.store() as conn:
        store.bootstrap(conn)
    typer.echo(f"# bootstrap: схема в {store.DB_PATH} готова", err=True)

    # Шаг 2: discover контейнеров через Portainer API.
    client = portainer_discover.make_client_from_env(portainer_url_override=portainer_url)
    items = portainer_discover.discover(client)
    if not items:
        typer.echo("mpu init: ни одного контейнера не найдено", err=True)
        raise typer.Exit(code=1)

    sl_items = sorted(
        (i for i in items if i.server_number is not None),
        key=lambda i: i.server_number or 0,
    )
    other_count = len(items) - len(sl_items)

    typer.echo(f"# найдено sl-N контейнеров: {len(sl_items)}")
    for item in sl_items:
        typer.echo(
            f"sl-{item.server_number}: {item.container_name} [{item.state or '?'}] "
            f"@ endpoint {item.endpoint_id} ({item.endpoint_name or '?'}) "
            f"-> {item.portainer_url}/{item.endpoint_id}"
        )
    typer.echo(f"# прочих контейнеров: {other_count}")

    if dry_run:
        typer.echo(f"# dry-run: всего {len(items)} контейнеров (в SQLite не записано)", err=True)
        return

    with store.store() as conn:
        if reset:
            removed = portainer_discover.reset_table(conn)
            typer.echo(f"# --reset: удалено {removed} старых записей", err=True)
        portainer_discover.store_discovered(items, conn)
    typer.echo(
        f"# записано {len(items)} контейнеров в {store.DB_PATH}",
        err=True,
    )
