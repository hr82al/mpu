"""mpu — top-level Typer CLI. Subcommands are added via `app.add_typer(...)`.

Три namespace'а монтируются в один `app`:
- root: `mpu <X>` (бывший `mpu-X`) — print + clipboard
- `mpu p <X>` (бывший `mpup-X`) — exec через Portainer; `--print` возвращает в print-mode
- `mpu api <X>` (бывший `mpuapi-X`) — HTTP-клиенты sl-back (click.Group)
"""

import importlib
import os
from typing import Annotated, cast

import click
import typer

from mpu import __version__
from mpu.cli_registry import PORTAINER_COMMANDS, PRINT_COMMANDS
from mpu.lib import loki_discover, portainer_discover, store
from mpu.lib.cli_wrap import PRINT_ONLY_ENV, WRAPPER_ENV

app = typer.Typer(
    name="mpu",
    help="Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.",
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.callback()
def _root() -> None:  # pyright: ignore[reportUnusedFunction]
    """Удерживает multi-command структуру: без callback typer схлопывает single command в root."""


def _mount(parent: typer.Typer, registry: dict[str, tuple[str, str]]) -> None:
    """Смонтировать подкоманды из registry в `parent` Typer-app.

    Для single-command Typer-app'ов (например `search.py` с одной `@app.command()`)
    регистрируем команду напрямую — иначе при `add_typer` Typer требует явный
    subcommand-name (`mpu search main 1` вместо ожидаемого `mpu search 1`).
    Для multi-command app'ов (`data-loader find-candidate`, и т.п.) — обычный `add_typer`.
    """
    for name, (module, attr) in registry.items():
        sub_app = getattr(importlib.import_module(module), attr)
        registered = sub_app.registered_commands
        if len(registered) == 1 and not sub_app.registered_groups:
            # Single-command — re-register функцию напрямую под kebab-name.
            # Иначе `mpu search 1` → "Missing command", потребует `mpu search main 1`.
            help_text = sub_app.info.help if isinstance(sub_app.info.help, str) else None
            # context_settings per-command важны для passthrough-обёрток
            # (allow_extra_args / ignore_unknown_options / help_option_names=[]),
            # см. mpu.commands.{sheet,xlsx,db}. Без проброса Click перехватывает `--help`.
            ctx_settings = registered[0].context_settings
            parent.command(name=name, help=help_text, context_settings=ctx_settings)(
                registered[0].callback
            )
        else:
            parent.add_typer(sub_app, name=name)


_mount(app, PRINT_COMMANDS)

p_app = typer.Typer(
    name="p",
    help="Portainer-exec namespace (бывший `mpup-*`). Дефолт — выполнение через Portainer; "
    "`--print` возвращает в print + clipboard.",
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@p_app.callback()
def _p_root(  # pyright: ignore[reportUnusedFunction]
    print_only: Annotated[
        bool,
        typer.Option("--print", "-p", help="Печатать строку обёртки + clipboard, не выполнять."),
    ] = False,
) -> None:
    """Перед диспатчем subcommand: `MPU_WRAPPER=portainer` (+ опционально `MPU_PRINT_ONLY=1`).

    Существующая логика `emit_node_cli()` в `mpu.lib.cli_wrap` читает обе env'ы.
    """
    os.environ[WRAPPER_ENV] = "portainer"
    if print_only:
        os.environ[PRINT_ONLY_ENV] = "1"


_mount(p_app, PORTAINER_COMMANDS)
app.add_typer(p_app)


def main() -> None:
    """Entry point для `mpu` бинаря (pyproject.toml#[project.scripts]).

    Конвертирует Typer-app в click.Group и добавляет `api` (нативный click.Group)
    как subcommand. Прямое монтирование через `app.add_typer(...)` не подходит:
    `build_api_group()` возвращает `click.Group`, не `typer.Typer`.
    """
    from mpu.commands._mpuapi_runtime import build_api_group

    # Typer.main.get_command возвращает click.Command (на уровне типов),
    # но при multi-command typer-app — это всегда click.Group.
    click_app = cast(click.Group, typer.main.get_command(app))
    click_app.add_command(build_api_group(), name="api")
    click_app()


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
    потом читает `mpu p ssh` для резолва Portainer-транспорта.
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

    # Шаг 3: discover Loki labels (hosts/services) для shell completion. Best-effort:
    # если LOKI_URL не задан / Loki недоступен — пропускаем без ошибки.
    loki_result = loki_discover.discover_and_store()
    if loki_result.error:
        typer.echo(f"# loki: пропущено ({loki_result.error})", err=True)
    else:
        n_services = sum(len(v) for v in loki_result.services_by_host.values())
        typer.echo(
            f"# loki: {len(loki_result.hosts)} hosts, {n_services} (host, service) пар",
            err=True,
        )
