"""`mpu-run-js` — выполнить произвольный ESM-код внутри `mp-sl-N-cli` контейнера.

JS поступает из (в порядке приоритета):
  1. Позиционный аргумент `code` (для однострочников).
  2. `--file/-f path/to/script.mjs`.
  3. stdin: pipe (`cat x.mjs | mpu-run-js ...`) либо интерактивный TTY с EOF (Ctrl+D).

Цели — селектор серверов:
  - `--server sl-N`     — один сервер;
  - `--servers sl-1,sl-2` — явный список;
  - `--all`             — все sl-N (N>0) из `~/.config/mpu/.env`.

По умолчанию JS выполняется через `mpu.lib.pssh.pssh_run` (ssh+docker exec или Portainer
HTTP API — выбирается per-server по `~/.config/mpu/.env`); при `--dry-run` печатается
copy-pasteable `mpu-pssh sl-N -- node ... <<HEREDOC` блок и копируется в clipboard.

Скрипт исполняется через `node --input-type=module -`, поэтому ему доступны
node_modules sl-back, import aliases (`#bullmq/...`), env (Redis/PG hosts),
`"type": "module"` из `package.json`. Cwd внутри контейнера — корень приложения.
"""

import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.pssh import pssh_run

COMMAND_NAME = "mpu-run-js"
COMMAND_SUMMARY = "Запустить произвольный JS внутри mp-sl-N-cli (ssh+docker или Portainer)"

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


def _parse_server_arg(value: str) -> int:
    n = servers.server_number(value)
    if n is None or n <= 0:
        typer.echo(f"{COMMAND_NAME}: ожидается sl-N (N>0), получено: {value!r}", err=True)
        raise typer.Exit(code=2)
    return n


def _resolve_servers(
    server: str | None,
    servers_csv: str | None,
    all_active: bool,
) -> list[int]:
    """Один из --server / --servers / --all обязателен. Возвращает отсортированные номера."""
    selectors_set = sum(
        1 for x in (server, servers_csv, True if all_active else None) if x is not None
    )
    if selectors_set != 1:
        typer.echo(
            f"{COMMAND_NAME}: укажите ровно один из --server / --servers / --all",
            err=True,
        )
        raise typer.Exit(code=2)
    if all_active:
        nums = servers.list_instance_server_numbers()
        if not nums:
            typer.echo(
                f"{COMMAND_NAME}: в ~/.config/mpu/.env нет sl_N / sl_N_portainer (N>0)",
                err=True,
            )
            raise typer.Exit(code=2)
        return nums
    if servers_csv is not None:
        parts = [p.strip() for p in servers_csv.split(",") if p.strip()]
        if not parts:
            typer.echo(f"{COMMAND_NAME}: пустой --servers", err=True)
            raise typer.Exit(code=2)
        return sorted({_parse_server_arg(p) for p in parts})
    assert server is not None
    return [_parse_server_arg(server)]


def _build_dry_run_block(target_numbers: list[int], js: str) -> str:
    """Печать `mpu-pssh sl-N -- node --input-type=module - <<HEREDOC` блока.

    Одинаково для ssh и Portainer — `mpu-pssh` сам выберет транспорт при paste'е.
    """
    js_body = js.rstrip("\n")
    lines: list[str] = []
    for n in target_numbers:
        if len(target_numbers) > 1:
            lines.append(f"# server=sl-{n}")
        lines.append(f"mpu-pssh sl-{n} -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'")
        lines.append(js_body)
        lines.append("__MPU_RUN_JS_EOF__")
    return "\n".join(lines)


@app.command()
def main(
    code: Annotated[
        str | None,
        typer.Argument(help="Inline ESM-код (опциональный позиционный)"),
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
    server: Annotated[
        str | None,
        typer.Option("--server", help="Один сервер: sl-N"),
    ] = None,
    servers_csv: Annotated[
        str | None,
        typer.Option("--servers", help="Список серверов: sl-1,sl-2"),
    ] = None,
    all_active: Annotated[
        bool,
        typer.Option("--all", help="Все sl-N (N>0) из ~/.config/mpu/.env"),
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
    js = _resolve_js_source(code=code, file=file)
    target_numbers = _resolve_servers(server, servers_csv, all_active)

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
