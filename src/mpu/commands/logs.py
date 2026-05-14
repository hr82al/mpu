"""`mpu logs` — логи контейнеров со стенда.

По умолчанию (`--via loki`) запрос идёт в Loki через `LOKI_URL` (см. `~/.config/mpu/.env`):
длинная история, фильтры по labels (host / compose_service / level / stream),
text grep, кросс-сервисный поиск по client_id (substring в строке).

`--via portainer` — fallback к старому поведению `mpu logs`: один контейнер за вызов
через Portainer Docker API. Полезно если Loki недоступен или нужен свежий snapshot
конкретного container'а сразу после деплоя.

Naming: эта команда — намеренное исключение из конвенции `mpu-* = print, mpup-* = portainer`.
Для logs "print command" use-case никогда не использовался; `mpu logs` стал
основной командой с интегрированным переключателем источника.

Использование:
    mpu logs ls                                   # список hosts из кэша
    mpu logs sl-1 ls                              # список services для sl-1
    mpu logs sl-1                                 # все логи sl-1 (последние 5 мин)
    mpu logs sl-1 wb-loader [--tail 200] [--since 1h]
    mpu logs sl-1 --grep "ECONNREFUSED" --since 1h
    mpu logs sl-1 --client 123 --since 30m        # cross-service по client_id
    mpu logs sl-1 wb-loader --via portainer       # legacy snapshot одного контейнера

Shell completion (hosts/services из SQLite-кэша) — установить через
`scripts/reinstall.sh` или `mpu logs --install-completion`. Кэш заполняет
`mpu init` (bootstrap) и `mpu update` (refresh).
"""

from typing import Annotated

import typer

from mpu.commands import _logs_loki, _logs_portainer

COMMAND_NAME = "mpu logs"
COMMAND_SUMMARY = "Логи со стенда: Loki по умолчанию, --via portainer для одиночного контейнера"

_LS = "ls"


def _complete_selector(incomplete: str) -> list[str]:
    """Tab-completion для первого позиционного: hosts из SQLite-кэша + 'ls'."""
    hosts = _logs_loki.cached_hosts()
    candidates = [_LS, *hosts]
    return [c for c in candidates if c.startswith(incomplete)]


def _complete_service(ctx: typer.Context, incomplete: str) -> list[str]:
    """Tab-completion для второго позиционного: services для уже выбранного host + 'ls'.

    Если selector — прямой host (sl-N / wb-N / dt-N / wb-clusters / wb-positions),
    фильтруем по нему. Иначе — отдаём общий список всех services из кэша
    (например когда selector — это client_id, и до резолва SQLite в completer'е
    мы не доходим, чтобы не тормозить TAB).
    """
    hosts = set(_logs_loki.cached_hosts())
    selector_param = ctx.params.get("selector")
    selector = selector_param if isinstance(selector_param, str) else None
    if selector and selector in hosts:
        services = _logs_loki.cached_services_for_host(selector)
    else:
        services = _logs_loki.cached_all_services()
    candidates = [_LS, *services]
    return [c for c in candidates if c.startswith(incomplete)]


def _complete_via(incomplete: str) -> list[str]:
    return [v for v in ("loki", "portainer") if v.startswith(incomplete)]


def _complete_level(incomplete: str) -> list[str]:
    return [v for v in ("error", "warn", "info", "debug") if v.startswith(incomplete)]


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="'ls' | sl-N / wb-N / dt-N / wb-(clusters|positions) | client_id / ss / title",
            autocompletion=_complete_selector,
        ),
    ],
    service: Annotated[
        str | None,
        typer.Argument(
            help="'ls' | для loki: compose_service (api / wb-loader / ...); "
            "для --via portainer: container substring",
            autocompletion=_complete_service,
        ),
    ] = None,
    via: Annotated[
        str,
        typer.Option(
            "--via",
            help="Источник: 'loki' (default) или 'portainer'",
            autocompletion=_complete_via,
        ),
    ] = "loki",
    tail: Annotated[
        int,
        typer.Option("--tail", "-n", help="Сколько последних строк показать"),
    ] = 200,
    since: Annotated[
        str | None,
        typer.Option(
            "--since",
            help="Relative (10m/1h/30s/2d) или Unix-ts; default loki=5m, portainer=без ограничения",
        ),
    ] = None,
    timestamps: Annotated[
        bool,
        typer.Option("--timestamps", "-t", help="Включить timestamp в начало строк"),
    ] = False,
    no_stdout: Annotated[
        bool,
        typer.Option("--no-stdout", help="Не показывать stdout"),
    ] = False,
    no_stderr: Annotated[
        bool,
        typer.Option("--no-stderr", help="Не показывать stderr"),
    ] = False,
    grep: Annotated[
        str | None,
        typer.Option("--grep", help="Loki: подстрока в строке лога (LogQL `|=`)"),
    ] = None,
    level: Annotated[
        str | None,
        typer.Option(
            "--level",
            help="Loki: фильтр по detected_level (error / warn / info / debug)",
            autocompletion=_complete_level,
        ),
    ] = None,
    client_id: Annotated[
        int | None,
        typer.Option("--client", help="Loki: substring `<client_id>` в строке (cross-service)"),
    ] = None,
) -> None:
    """Логи со стенда (Loki по умолчанию, --via portainer для legacy snapshot)."""
    # `ls` режим — листинг из SQLite-кэша.
    if selector == _LS:
        _logs_loki.print_hosts_ls(command_name=COMMAND_NAME)
        return
    if service == _LS:
        _logs_loki.print_services_ls(selector, command_name=COMMAND_NAME)
        return

    if via == "portainer":
        if service is None:
            typer.echo(
                f"{COMMAND_NAME}: --via portainer требует <container> "
                f"(2-й позиционный аргумент)",
                err=True,
            )
            raise typer.Exit(code=2)
        _logs_portainer.run(
            command_name=COMMAND_NAME,
            selector=selector,
            container=service,
            tail=tail,
            since=since,
            timestamps=timestamps,
            no_stdout=no_stdout,
            no_stderr=no_stderr,
        )
        return

    if via != "loki":
        typer.echo(f"{COMMAND_NAME}: --via {via!r}, ожидается 'loki' или 'portainer'", err=True)
        raise typer.Exit(code=2)

    _logs_loki.run(
        command_name=COMMAND_NAME,
        selector=selector,
        service=service,
        tail=tail,
        since=since,
        timestamps=timestamps,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep,
        level=level,
        client_id=client_id,
    )
