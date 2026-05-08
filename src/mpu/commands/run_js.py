"""`mpu-run-js` — выполнить произвольный ESM-код внутри `mp-sl-N-cli` контейнера.

Селектор сервера — позиционный, универсальный (см. `mpu.lib.resolver.resolve_server`):
  - `sl-N` — прямой указатель сервера (без обращения к SQLite-кэшу);
  - `client_id` (число), кусок `spreadsheet_id`, кусок `title` — резолв через `mpu-search`
    (локальный SQLite-кэш `~/.config/mpu/mpu.db`, обновляется через `mpu-update`).

Альтернатива — `--all`: fan-out по всем sl-N (N>0) из SQLite-кэша
(`mpu init` наполняет `portainer_containers`). Селектор и `--all` взаимоисключающи.

JS поступает из (в порядке приоритета):
  1. Позиционный аргумент `code` после селектора (для однострочников);
  2. `--file/-f path/to/script.mjs`;
  3. stdin: pipe (`cat x.mjs | mpu-run-js ...`) либо интерактивный TTY с EOF (Ctrl+D).

По умолчанию JS выполняется через `mpu.lib.pssh.pssh_run` (ssh+docker exec или Portainer
HTTP API — выбирается per-server по `~/.config/mpu/.env`); при `--dry-run` печатается
copy-pasteable `mpup-ssh sl-N -- node ... <<HEREDOC` блок и копируется в clipboard.

Скрипт исполняется через `node --input-type=module -`, поэтому ему доступны
node_modules sl-back, import aliases (`#bullmq/...`), env (Redis/PG hosts),
`"type": "module"` из `package.json`. Cwd внутри контейнера — корень приложения.

Примеры:
  mpu-run-js sl-1 'console.log(1)'
  mpu-run-js 12345 'console.log(1)'           # client_id → server через mpu-search
  mpu-run-js "Тортуга main" -f script.mjs     # title → server через mpu-search
  cat script.mjs | mpu-run-js sl-11
  mpu-run-js --all 'console.log("on every sl-N")'
"""

import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.pssh import pssh_run
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

COMMAND_NAME = "mpu-run-js"
COMMAND_SUMMARY = "Запустить произвольный JS внутри mp-sl-N-cli по селектору (или --all)"

# Команда, которой кормим JS на каждом сервере: ESM из stdin.
_NODE_CMD = ["node", "--input-type=module", "-"]


app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _resolve_js_source(*, code: str | None, file: Path | None) -> str:
    """Получить JS из одного из трёх источников. Приоритет: позиционный → --file → stdin.

    Позиционный и --file взаимоисключающи. Если ни одного — читаем sys.stdin.read();
    для TTY печатаем подсказку про Ctrl+D в stderr.
    """
    if code is not None and file is not None:
        typer.echo(f"{COMMAND_NAME}: позиционный JS и --file взаимоисключающи", err=True)
        raise typer.Exit(code=2)
    if code is not None:
        js = code
    elif file is not None:
        js = file.read_text(encoding="utf-8")
    else:
        if sys.stdin.isatty():
            typer.echo(f"{COMMAND_NAME}: введите ESM-код, завершите Ctrl+D", err=True)
        js = sys.stdin.read()
    if not js.strip():
        typer.echo(f"{COMMAND_NAME}: пустой JS", err=True)
        raise typer.Exit(code=2)
    return js


def _resolve_selector_to_number(selector: str) -> int:
    """Селектор → server_number (N>0). sl-0 — main, не cli-таргет."""
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


def _resolve_servers(selector: str | None, all_active: bool) -> list[int]:
    """Селектор и `--all` взаимоисключающи; ровно один обязателен."""
    if (selector is None) == (not all_active):
        typer.echo(
            f"{COMMAND_NAME}: укажите ровно один из <selector> / --all",
            err=True,
        )
        raise typer.Exit(code=2)
    if all_active:
        nums = servers.list_instance_server_numbers()
        if not nums:
            typer.echo(
                f"{COMMAND_NAME}: в SQLite-кэше нет sl-N (N>0); запусти `mpu init`",
                err=True,
            )
            raise typer.Exit(code=2)
        return nums
    assert selector is not None
    return [_resolve_selector_to_number(selector)]


def _build_dry_run_block(target_numbers: list[int], js: str) -> str:
    """Печать `mpup-ssh sl-N -- node --input-type=module - <<HEREDOC` блока.

    Одинаково для ssh и Portainer — `mpup-ssh` сам выберет транспорт при paste'е.
    """
    js_body = js.rstrip("\n")
    lines: list[str] = []
    for n in target_numbers:
        if len(target_numbers) > 1:
            lines.append(f"# server=sl-{n}")
        lines.append(f"mpup-ssh sl-{n} -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'")
        lines.append(js_body)
        lines.append("__MPU_RUN_JS_EOF__")
    return "\n".join(lines)


@app.command()
def main(
    selector: Annotated[
        str | None,
        typer.Argument(
            help="sl-N (прямо) или client_id / spreadsheet_id / title (через mpu-search). "
            "Взаимоисключающе с --all."
        ),
    ] = None,
    code: Annotated[
        str | None,
        typer.Argument(help="Inline ESM-код (после селектора)"),
    ] = None,
    file: Annotated[
        Path | None,
        typer.Option(
            "--file",
            "-f",
            help="Путь к .mjs/.js файлу с ESM-кодом",
            exists=True,
            dir_okay=False,
            readable=True,
        ),
    ] = None,
    all_active: Annotated[
        bool,
        typer.Option("--all", help="Fan-out на все sl-N (N>0) из SQLite-кэша `mpu init`"),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Только напечатать команду(ы) + clipboard, не выполнять"),
    ] = False,
    via: Annotated[
        str | None,
        typer.Option("--via", help="Override транспорта для всех целей: ssh | portainer"),
    ] = None,
) -> None:
    # При --all позиционный <selector> не имеет смысла (нет per-server резолва).
    # Repurpose: первый позиционный (попавший в `selector`) трактуем как inline-код.
    if all_active and selector is not None:
        if code is not None:
            typer.echo(
                f"{COMMAND_NAME}: с --all допустим максимум один позиционный (<code>); "
                f"<selector> избыточен",
                err=True,
            )
            raise typer.Exit(code=2)
        code, selector = selector, None
    target_numbers = _resolve_servers(selector, all_active)
    js = _resolve_js_source(code=code, file=file)

    if dry_run:
        block = _build_dry_run_block(target_numbers, js)
        typer.echo(block)
        copy_to_clipboard(block)
        return

    targets_repr = ", ".join(f"sl-{n}" for n in target_numbers)
    typer.echo(f"# {COMMAND_NAME}: targets = [{targets_repr}]", err=True)
    js_bytes = js.encode("utf-8")
    for n in target_numbers:
        typer.echo(f"# server=sl-{n}", err=True)
        rc = pssh_run(server_number=n, cmd=_NODE_CMD, stdin=js_bytes, via=via)
        if rc != 0:
            typer.echo(f"{COMMAND_NAME}: sl-{n} exit={rc} — abort", err=True)
            raise typer.Exit(code=rc)


def run() -> None:
    """Entry point для `mpu-run-js`."""
    app()
