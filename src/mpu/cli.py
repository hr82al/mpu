"""mpu — top-level CLI: root-команды (Typer-app) + `api`-namespace (click.Group).

Монтаж root-подкоманд — `_mount(app, COMMANDS)`: single-command app'ы регистрируются
напрямую через `app.command(...)`, multi-command — через `app.add_typer(...)`. Дефолтное
поведение root-команды — выполнение inner-команды (через Portainer для node-CLI обёрток,
нативно для native-команд); `--print` / `-p` в обёртках возвращает в print + clipboard режим.

`mpu api <X>` — HTTP-клиенты sl-back; click.Group из `build_api_group()`, добавляется в
`main()` на уровне click поверх сконвертированного Typer-app (не входит в `COMMANDS`).
"""

import asyncio
import importlib
import sys
from typing import Annotated, cast

import click
import typer

from mpu import __version__
from mpu.cli_registry import COMMANDS
from mpu.lib import env, kaiten_cache, loki_discover, portainer_discover, store, telegram

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


_mount(app, COMMANDS)


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

    # Шаг 4: discover Kaiten spaces/boards/lanes/columns для дискаверабилити + shell
    # completion `mpu kiten ls` (--space / --board / --lane / --column). Best-effort: нет
    # KITEN_API_KEY / Kaiten недоступен — пропускаем без ошибки. Дорожки и колонки —
    # по +1 запросу на доску каждая.
    kaiten_result = kaiten_cache.discover_and_store()
    if kaiten_result.error:
        typer.echo(f"# kaiten: пропущено ({kaiten_result.error})", err=True)
    else:
        board_ids = [b.id for b in kaiten_result.boards]
        lanes_result = kaiten_cache.discover_lanes_and_store(board_ids)
        columns_result = kaiten_cache.discover_columns_and_store(board_ids)
        n_lanes = "?" if lanes_result.error else str(len(lanes_result.lanes))
        n_columns = "?" if columns_result.error else str(len(columns_result.columns))
        typer.echo(
            f"# kaiten: {len(kaiten_result.spaces)} spaces, "
            f"{len(kaiten_result.boards)} boards, {n_lanes} lanes, {n_columns} columns",
            err=True,
        )

    # Шаг 5: telegram login (best-effort, интерактивный). Логинимся ОДИН раз и пишем
    # creds + StringSession в .env. Уже залогинены → пропуск; нет TTY → пропуск (init
    # остаётся неинтерактивным в пайпах/CI); нет creds → спрашиваем (с объяснением, где взять).
    _telegram_login_step()


def _read_stdin_line() -> str:
    """Прочитать строку из stdin В ОБХОД readline.

    `input()` под GNU readline на ряде терминалов/локалей падает UnicodeDecodeError даже на
    ASCII-промпте (readline при перерисовке строки подмешивает байты предыдущего вывода).
    Читаем сырые байты и декодируем utf-8 с заменой битых — line-editing для setup-промптов
    не нужен. EOF → пустая строка.
    """
    raw = sys.stdin.buffer.readline()
    return raw.decode("utf-8", "replace").strip()


def _ask(label: str) -> str:
    """Видимый вопрос: label → stderr (без перевода строки), ответ ← stdin (без readline)."""
    typer.echo(label, nl=False, err=True)
    return _read_stdin_line()


def _ask_yes_no(label: str) -> bool:
    """y/N вопрос (дефолт — No)."""
    return _ask(f"{label} [y/N]: ").lower() in ("y", "yes")


def _ask_secret(label: str) -> str:
    """Скрытый ввод (2FA-пароль). getpass не использует GNU readline; при сбое — видимый ввод."""
    import getpass

    try:
        return getpass.getpass(label).strip()
    except (EOFError, OSError, UnicodeError):
        return _ask(label)


def _ensure_telegram_creds() -> bool:
    """Гарантировать TELEGRAM_API_ID/HASH в .env. Спросить с объяснением, если их нет.

    Возвращает True, если creds на месте (или введены), False — если пользователь отказался
    / ввёл пусто. Пишет введённые значения в ~/.config/mpu/.env.
    """
    if env.get("TELEGRAM_API_ID") and env.get("TELEGRAM_API_HASH"):
        return True
    typer.echo(
        "# telegram: не настроен. Для отправки сообщений от вашего имени нужны api_id и\n"
        "#   api_hash с https://my.telegram.org → 'API development tools' (войти по номеру,\n"
        "#   создать приложение: App title / short name любые, Platform — Other).",
        err=True,
    )
    if not _ask_yes_no("Set up Telegram now?"):
        typer.echo(
            "# telegram: пропущено (позже: заполнить TELEGRAM_API_ID/HASH в .env и `mpu init`)",
            err=True,
        )
        return False
    typer.echo(
        "# После создания приложения на my.telegram.org страница покажет два значения\n"
        "#   (блок 'App configuration'):\n"
        "#   • api_id   — целое число, идентификатор приложения (напр. 1234567);\n"
        "#   • api_hash — строка из 32 hex-символов, секрет приложения\n"
        "#                (напр. 0123456789abcdef0123456789abcdef).\n"
        "#   Это креды ПРИЛОЖЕНИЯ (не вашего аккаунта), общие для всех ваших чатов;\n"
        "#   вводятся один раз, хранятся в ~/.config/mpu/.env.",
        err=True,
    )
    api_id = _ask("api_id (integer): ")
    api_hash = _ask("api_hash (32 hex chars): ")
    if not (api_id and api_hash):
        typer.echo("# telegram: пропущено (api_id/api_hash пустые)", err=True)
        return False
    env.set_persistent("TELEGRAM_API_ID", api_id)
    env.set_persistent("TELEGRAM_API_HASH", api_hash)
    typer.echo("# telegram: api_id/api_hash записаны в .env", err=True)
    return True


def _telegram_login_step() -> None:
    """Интерактивный вход в Telegram при `mpu init` (идемпотентно, best-effort)."""
    if env.get("TELEGRAM_SESSION"):
        typer.echo("# telegram: уже авторизован, пропускаю", err=True)
        return
    if not sys.stdin.isatty():
        typer.echo(
            "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)",
            err=True,
        )
        return
    if not _ensure_telegram_creds():
        return
    try:
        cfg = telegram.TgConfig.from_env()
        phone = env.get("TELEGRAM_PHONE")
        if not phone:
            phone = _ask("Telegram phone (e.g. +79991234567): ")
            env.set_persistent("TELEGRAM_PHONE", phone)
        session = asyncio.run(
            telegram.interactive_login(
                cfg,
                phone=phone,
                prompt_code=lambda: _ask("Telegram login code (from Telegram): "),
                prompt_password=lambda: _ask_secret("2FA password: "),
            )
        )
        env.set_persistent("TELEGRAM_SESSION", session)
        typer.echo("# telegram: авторизован, сессия записана в .env", err=True)
    except telegram.TgError as e:
        typer.echo(f"# telegram: пропущено ({e})", err=True)
