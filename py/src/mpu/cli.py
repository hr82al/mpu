"""mpu — top-level CLI: root-команды (Typer-app) + `api`-namespace (click.Group).

Монтаж root-подкоманд — `_mount(app, COMMANDS)`: single-command app'ы регистрируются
напрямую через `app.command(...)`, multi-command — через `app.add_typer(...)`. Дефолтное
поведение root-команды — выполнение inner-команды (через Portainer для node-CLI обёрток,
нативно для native-команд); `--print` / `-p` в обёртках возвращает в print + clipboard режим.

`mpu api <X>` — HTTP-клиенты sl-back; click.Group из `build_api_group()`, добавляется в
`main()` на уровне click поверх сконвертированного Typer-app (не входит в `COMMANDS`).
"""

import importlib
from typing import Annotated, cast

import click
import typer
from typer.core import TyperGroup

from mpu import __version__
from mpu.cli_registry import COMMANDS

_API_GROUP_NAME = "api"

# Служебный слепок дерева команд. Резолвится по имени, но в `list_commands` не входит:
# в `mpu --help`, `mpu help` и completion его быть не должно — это машинный интерфейс,
# а не команда пользователя, и его появление изменило бы наблюдаемую поверхность CLI.
_MANIFEST_NAME = "manifest"
_MANIFEST_SPEC = ("mpu.commands.manifest", "app")


class _LazyGroup(TyperGroup):
    """Root-группа, импортирующая модуль подкоманды только при обращении к ней.

    Монтировать все 54 команды заранее — значит на каждый вызов `mpu` тянуть `psycopg`,
    `httpx`, `asyncio` и остальное, что нужно одной-двум из них (около секунды на старте).
    Здесь список имён берётся из реестра без импорта, а модуль грузится в `get_command`.
    Цена: `mpu --help` печатает summary всех команд, поэтому импортирует их все — редкий
    случай, ради которого нет смысла держать реестр с продублированными описаниями.
    """

    def list_commands(self, ctx: click.Context) -> list[str]:
        known = super().list_commands(ctx)
        return [*COMMANDS, *known, *([] if _API_GROUP_NAME in known else [_API_GROUP_NAME])]

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        known = super().get_command(ctx, cmd_name)
        if known is not None:
            return known
        if cmd_name == _API_GROUP_NAME:
            from mpu.commands._mpuapi_runtime import build_api_group

            api_group = build_api_group()
            self.add_command(api_group, _API_GROUP_NAME)
            return api_group
        spec = COMMANDS.get(cmd_name)
        if spec is None and cmd_name == _MANIFEST_NAME:
            spec = _MANIFEST_SPEC
        if spec is None:
            return None
        holder = typer.Typer()
        holder.callback()(lambda: None)  # без callback typer схлопнет single-command в root
        _mount(holder, {cmd_name: spec})
        built = cast(click.Group, typer.main.get_command(holder))
        command = built.get_command(ctx, cmd_name)
        if command is not None:
            self.add_command(command, cmd_name)  # второй вызов в том же процессе — из кэша
        return command


app = typer.Typer(
    name="mpu",
    cls=_LazyGroup,
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
            # help команды приоритетнее group-help (Typer(help=...)): у single-command
            # app'а пользователь видит именно команду.
            cmd_help = registered[0].help
            app_help = sub_app.info.help if isinstance(sub_app.info.help, str) else None
            help_text = cmd_help if isinstance(cmd_help, str) else app_help
            # context_settings per-command важны для passthrough-обёрток
            # (allow_extra_args / ignore_unknown_options / help_option_names=[]),
            # см. mpu.commands.{sheet,xlsx,db}. Без проброса Click перехватывает `--help`.
            ctx_settings = registered[0].context_settings
            parent.command(name=name, help=help_text, context_settings=ctx_settings)(
                registered[0].callback
            )
        else:
            parent.add_typer(sub_app, name=name)


def main() -> None:
    """Entry point для `mpu` бинаря (pyproject.toml#[project.scripts]).

    Конвертирует Typer-app в click.Group; `api` — нативный `click.Group`, не `typer.Typer`,
    поэтому монтируется не через `app.add_typer(...)`, а лениво в `_LazyGroup.get_command`
    (его сборка тянет спеку ~86 endpoint'ов и httpx — не за каждый вызов CLI).
    """
    # Typer.main.get_command возвращает click.Command (на уровне типов),
    # но при multi-command typer-app — это всегда click.Group.
    click_app = cast(click.Group, typer.main.get_command(app))
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

    Кэшируем все контейнеры, помечая cli-контейнеры серверов через `server_number`. Этот кэш
    потом читает `mpu p ssh` для резолва Portainer-транспорта.
    """
    # Импорт здесь, а не на уровне модуля: psycopg/httpx/asyncio нужны только этой команде,
    # а `mpu.cli` грузится на каждый вызов CLI (см. _LazyGroup).

    # Шаг 1: bootstrap SQLite-схемы (отсюда — всегда, других мест нет).
    _bootstrap_step()
    if not _portainer_step(portainer_url=portainer_url, dry_run=dry_run, reset=reset):
        return
    _loki_step()
    _kaiten_step()
    # Telegram — последним: единственный интерактивный шаг, спрашивает только при TTY.
    from mpu.commands.telegram import run_login_step

    run_login_step()


def _bootstrap_step() -> None:
    """Шаг 1: схема SQLite. Единственное место, где она создаётся."""
    from mpu.lib import store

    with store.store() as conn:
        store.bootstrap(conn)
    typer.echo(f"# bootstrap: схема в {store.DB_PATH} готова", err=True)


def _portainer_step(*, portainer_url: str | None, dry_run: bool, reset: bool) -> bool:
    """Шаг 2: контейнеры через Portainer API → SQLite. False — дальше идти не нужно (dry-run)."""
    from mpu.lib import portainer_discover, store

    client = portainer_discover.make_client_from_env(portainer_url_override=portainer_url)
    items = portainer_discover.discover(client)
    if not items:
        typer.echo("mpu init: ни одного контейнера не найдено", err=True)
        raise typer.Exit(code=1)

    sl_items = sorted(
        (i for i in items if i.server_number is not None),
        key=lambda i: i.server_number or 0,
    )
    typer.echo(f"# найдено sl-N контейнеров: {len(sl_items)}")
    for item in sl_items:
        typer.echo(
            f"sl-{item.server_number}: {item.container_name} [{item.state or '?'}] "
            f"@ endpoint {item.endpoint_id} ({item.endpoint_name or '?'}) "
            f"-> {item.portainer_url}/{item.endpoint_id}"
        )
    typer.echo(f"# прочих контейнеров: {len(items) - len(sl_items)}")

    if dry_run:
        typer.echo(f"# dry-run: всего {len(items)} контейнеров (в SQLite не записано)", err=True)
        return False

    with store.store() as conn:
        if reset:
            removed = portainer_discover.reset_table(conn)
            typer.echo(f"# --reset: удалено {removed} старых записей", err=True)
        portainer_discover.store_discovered(items, conn)
    typer.echo(f"# записано {len(items)} контейнеров в {store.DB_PATH}", err=True)
    return True


def _loki_step() -> None:
    """Шаг 3: Loki labels для shell completion. Best-effort: нет LOKI_URL — просто пропуск."""
    from mpu.lib import loki_discover

    result = loki_discover.discover_and_store()
    if result.error:
        typer.echo(f"# loki: пропущено ({result.error})", err=True)
        return
    n_services = sum(len(v) for v in result.services_by_host.values())
    typer.echo(f"# loki: {len(result.hosts)} hosts, {n_services} (host, service) пар", err=True)


def _kaiten_step() -> None:
    """Шаг 4: справочники Kaiten для completion `kiten ls`/`time`.

    Best-effort: нет KITEN_API_KEY или Kaiten недоступен — пропуск без ошибки. Дорожки и
    колонки стоят по запросу на доску каждая, роли — один запрос на компанию.
    """
    from mpu.lib import kaiten_cache

    result = kaiten_cache.discover_and_store()
    if result.error:
        typer.echo(f"# kaiten: пропущено ({result.error})", err=True)
        return
    board_ids = [b.id for b in result.boards]
    lanes = kaiten_cache.discover_lanes_and_store(board_ids)
    columns = kaiten_cache.discover_columns_and_store(board_ids)
    roles = kaiten_cache.discover_roles_and_store()
    typer.echo(
        f"# kaiten: {len(result.spaces)} spaces, {len(result.boards)} boards, "
        f"{'?' if lanes.error else len(lanes.lanes)} lanes, "
        f"{'?' if columns.error else len(columns.columns)} columns, "
        f"{'?' if roles.error else len(roles.roles)} roles",
        err=True,
    )
