"""`mpu-logs` — логи контейнеров со стенда.

По умолчанию (`--via loki`) запрос идёт в Loki через `LOKI_URL` (см. `~/.config/mpu/.env`):
длинная история, фильтры по labels (host / compose_service / level / stream),
text grep, кросс-сервисный поиск по client_id (substring в строке).

`--via portainer` — fallback к старому поведению `mpup-logs`: один контейнер за вызов
через Portainer Docker API. Полезно если Loki недоступен или нужен свежий snapshot
конкретного container'а сразу после деплоя.

Naming: эта команда — намеренное исключение из конвенции `mpu-* = print, mpup-* = portainer`.
Для logs "print command" use-case никогда не использовался; `mpu-logs` стал
основной командой с интегрированным переключателем источника.

Использование:
    mpu-logs <selector> [--service api] [--tail 200] [--since 10m] [--level error]
    mpu-logs <selector> --grep "ECONNREFUSED" --since 1h
    mpu-logs <selector> --client 123 --since 30m              # cross-service по client_id
    mpu-logs <selector> --via portainer <container> [--tail 200] [--since 10m]
"""

from typing import Annotated

import typer

from mpu.commands import _logs_loki, _logs_portainer

COMMAND_NAME = "mpu-logs"
COMMAND_SUMMARY = "Логи со стенда: Loki по умолчанию, --via portainer для одиночного контейнера"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="sl-N / wb-N / dt-N / wb-(clusters|positions) либо client_id / spreadsheet/title",
        ),
    ],
    container: Annotated[
        str | None,
        typer.Argument(
            help="Имя контейнера (только при --via portainer; для loki укажи --service)",
        ),
    ] = None,
    via: Annotated[
        str,
        typer.Option("--via", help="Источник: 'loki' (default) или 'portainer'"),
    ] = "loki",
    service: Annotated[
        str | None,
        typer.Option(
            "--service",
            help="Loki: фильтр по compose_service (api / data-loader / wb-loader / ...)",
        ),
    ] = None,
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
        typer.Option("--level", help="Loki: фильтр по parsed level (info / warn / error / ...)"),
    ] = None,
    client_id: Annotated[
        int | None,
        typer.Option("--client", help="Loki: substring `<client_id>` в строке (для cross-service)"),
    ] = None,
) -> None:
    """Логи со стенда (Loki по умолчанию, --via portainer для legacy snapshot)."""
    if via == "portainer":
        if container is None:
            typer.echo(f"{COMMAND_NAME}: --via portainer требует <container>", err=True)
            raise typer.Exit(code=2)
        _logs_portainer.run(
            command_name=COMMAND_NAME,
            selector=selector,
            container=container,
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

    if container is not None:
        typer.echo(
            f"{COMMAND_NAME}: позиционный <container> используется только с --via portainer; "
            f"для loki укажи --service",
            err=True,
        )
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


def run() -> None:
    """Entry point для `mpu-logs`."""
    app()
