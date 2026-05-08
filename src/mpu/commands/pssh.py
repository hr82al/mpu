"""`mpu-pssh` — выполнить команду внутри `mp-sl-N-cli`; ssh+docker или Portainer transparently.

UX: `mpu-pssh <selector> <cmd...>` — единый интерфейс независимо от того, есть ли прямой ssh
или только Portainer-доступ. Селектор универсальный (см. `mpu.lib.resolver.resolve_server`):
  - `sl-N` — прямой указатель сервера (без обращения к SQLite-кэшу);
  - `client_id` (число), кусок `spreadsheet_id`, кусок `title` — резолв через `mpu-search`
    (локальный SQLite-кэш `~/.config/mpu/mpu.db`, обновляется через `mpu-update`).

Источники stdin (по аналогии с `mpu-sql` / `mpu-run-js`):
  1. `--stdin-text "..."` — inline-строка;
  2. `--stdin-file ./x` — содержимое файла;
  3. pipe: `cat x | mpu-pssh ...` (stdin не TTY);
  4. интерактивный TTY: подсказка про Ctrl+D, читаем до EOF.
Если ничего из этого не нужно — `--no-stdin` пропускает чтение.

stdout/stderr ребёнка — напрямую в наш stdout/stderr. Exit code наследуется.

Транспорт выбирается по `~/.config/mpu/.env`:
  - `sl_<N>=<ip>` + `PG_MY_USER_NAME` → ssh+docker exec
  - `sl_<N>_portainer=<base_url>/<endpoint_id>` + `PORTAINER_API_KEY` → Portainer HTTP API
  - оба заданы → ssh (быстрее); override через `--via portainer`

Примеры:
  mpu-pssh sl-1 --no-stdin -- ls -la /app
  mpu-pssh 12345 --no-stdin -- ls /app           # client_id → server через mpu-search
  mpu-pssh "Тортуга" --no-stdin -- ls /app       # title → server через mpu-search
  cat script.mjs | mpu-pssh sl-11 -- node --input-type=module -
  mpu-pssh sl-11 --stdin-text 'console.log(1)' -- node --input-type=module -
  mpu-pssh sl-1 --via portainer --no-stdin -- ls /app
  mpu-pssh sl-11 -- cat   # TTY: введите данные, завершите Ctrl+D
"""

import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import pssh as _pssh
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

COMMAND_NAME = "mpu-pssh"
COMMAND_SUMMARY = "Запустить cmd в mp-sl-N-cli по селектору (ssh+docker или Portainer)"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _resolve_server_number(selector: str) -> int:
    """Резолв селектора → server_number с проверкой N>0 (sl-0 = main, не cli-таргет)."""
    try:
        n, _candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None
    if n <= 0:
        typer.echo(f"{COMMAND_NAME}: ожидается sl-N (N>0), получено: {selector!r}", err=True)
        raise typer.Exit(code=2)
    return n


def _resolve_stdin(*, stdin_text: str | None, stdin_file: Path | None, no_stdin: bool) -> bytes:
    """Источники stdin (mutex): inline-строка / файл / pipe / TTY.

    `--no-stdin` сразу даёт `b""` — для команд (ls, echo), которым stdin не нужен,
    чтобы не блокироваться на TTY-prompt'е.
    """
    if no_stdin:
        if stdin_text is not None or stdin_file is not None:
            typer.echo(
                f"{COMMAND_NAME}: --no-stdin несовместим с --stdin-text / --stdin-file",
                err=True,
            )
            raise typer.Exit(code=2)
        return b""
    if stdin_text is not None and stdin_file is not None:
        typer.echo(f"{COMMAND_NAME}: --stdin-text и --stdin-file взаимоисключающи", err=True)
        raise typer.Exit(code=2)
    if stdin_text is not None:
        return stdin_text.encode("utf-8")
    if stdin_file is not None:
        return stdin_file.read_bytes()
    if sys.stdin.isatty():
        typer.echo(
            f"{COMMAND_NAME}: введите stdin для команды, завершите Ctrl+D "
            f"(или --no-stdin, если stdin не нужен)",
            err=True,
        )
    return sys.stdin.buffer.read()


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)
def main(
    ctx: typer.Context,
    selector: Annotated[
        str,
        typer.Argument(
            help="sl-N (прямо) или client_id / spreadsheet_id / title (через mpu-search)"
        ),
    ],
    via: Annotated[
        str | None,
        typer.Option("--via", help="Override транспорта: ssh | portainer"),
    ] = None,
    stdin_text: Annotated[
        str | None,
        typer.Option("--stdin-text", help="Inline-строка как stdin команды"),
    ] = None,
    stdin_file: Annotated[
        Path | None,
        typer.Option(
            "--stdin-file",
            help="Файл, содержимое которого пойдёт на stdin",
            exists=True,
            dir_okay=False,
            readable=True,
        ),
    ] = None,
    no_stdin: Annotated[
        bool,
        typer.Option("--no-stdin", help="Не читать stdin (для cmd, которым не нужен)"),
    ] = False,
) -> None:
    n = _resolve_server_number(selector)
    cmd = list(ctx.args)
    if not cmd:
        typer.echo(f"{COMMAND_NAME}: пустая команда", err=True)
        raise typer.Exit(code=2)
    stdin_bytes = _resolve_stdin(stdin_text=stdin_text, stdin_file=stdin_file, no_stdin=no_stdin)
    rc = _pssh.pssh_run(server_number=n, cmd=cmd, stdin=stdin_bytes, via=via)
    raise typer.Exit(code=rc)


def run() -> None:
    """Entry point для `mpu-pssh`."""
    app()
