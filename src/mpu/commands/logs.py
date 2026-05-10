"""`mpup-logs` — вывести последние строки логов контейнера на sl-N через Portainer.

Использование:
    mpup-logs <selector> <container> [--tail N] [--since 10m] [--no-stderr] [--no-stdout]

`<selector>` — `sl-N` либо client_id / spreadsheet_id / title (через `mpu-search`).
`<container>` — точное имя контейнера ИЛИ подстрока. Если по подстроке найдено
несколько — печатается список и Exit(2). Подсказка: `mpup-ps <selector>`.

`--tail` (default 200) — число последних строк. `--since 10m` / `--since 1h` /
`--since 30s` или ISO-8601 — относительное / абсолютное время. Stderr/stdout
демультиплексируются Docker-фреймингом и печатаются в наши stderr/stdout
соответственно (структура сохраняется).
"""

import sys
from typing import Annotated

import httpx
import typer

from mpu.commands._portainer_resolve import resolve_portainer
from mpu.lib.duration import DurationParseError, parse_since

COMMAND_NAME = "mpup-logs"
COMMAND_SUMMARY = "Логи контейнера на sl-N через Portainer (docker logs --tail)"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(help="sl-N либо client_id / spreadsheet_id / title (через mpu-search)"),
    ],
    container: Annotated[
        str,
        typer.Argument(help="Имя контейнера или подстрока (если уникальна)"),
    ],
    tail: Annotated[
        int,
        typer.Option("--tail", "-n", help="Сколько последних строк показать"),
    ] = 200,
    since: Annotated[
        str | None,
        typer.Option(
            "--since",
            help="Относительное (10m, 1h, 30s, 2d) или Unix-timestamp; пусто = без ограничения",
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
) -> None:
    """Tail-логи контейнера на sl-N (Docker logs API через Portainer)."""
    pr = resolve_portainer(selector=selector, command_name=COMMAND_NAME)
    name = _resolve_container_name(pr, container)
    since_ts = _since_or_exit(since)
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
        typer.echo(f"{COMMAND_NAME}: portainer error: {e}", err=True)
        raise typer.Exit(code=1) from None

    if not no_stdout and out:
        sys.stdout.buffer.write(out)
        sys.stdout.buffer.flush()
    if not no_stderr and err:
        sys.stderr.buffer.write(err)
        sys.stderr.buffer.flush()


def _resolve_container_name(pr: object, query: str) -> str:
    """Точное имя или однозначная подстрока. На неоднозначность — typer.Exit(2).

    `pr` типизирован как `object` чтобы избежать circular import; реально это
    `_portainer_resolve.PortainerResolved` (см. caller).
    """
    from mpu.commands._portainer_resolve import PortainerResolved

    assert isinstance(pr, PortainerResolved)
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
        typer.echo(f"{COMMAND_NAME}: контейнер {query!r} не найден на {sl}", err=True)
        typer.echo(f"  подсказка: mpup-ps {sl}", err=True)
        raise typer.Exit(code=2)
    if len(matches) > 1:
        typer.echo(
            f"{COMMAND_NAME}: подстрока {query!r} даёт несколько контейнеров на {sl}:",
            err=True,
        )
        for n in sorted(matches):
            typer.echo(f"  {n}", err=True)
        raise typer.Exit(code=2)
    return matches[0]


def _since_or_exit(s: str | None) -> int | None:
    """Обёртка над `lib.duration.parse_since` с CLI-friendly ошибкой."""
    if s is None:
        return None
    try:
        return parse_since(s)
    except DurationParseError as e:
        typer.echo(f"{COMMAND_NAME}: --since: {e}", err=True)
        raise typer.Exit(code=2) from None


def run() -> None:
    """Entry point для `mpup-logs`."""
    app()
