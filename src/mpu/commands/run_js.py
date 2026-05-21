"""`mpu run-js` — выполнить произвольный ESM-код внутри контейнера sl-back.

Селектор — позиционный, универсальный:
  - `sl-N` — прямой указатель сервера; код летит в `mp-sl-N-cli` (без обращения к кэшу);
  - точное compose-имя контейнера (например `mp-sl-9-wb-loader`) — Portainer-exec прямо
    в этот контейнер (резолв через SQLite-кэш `mpu init`);
  - `client_id` (число), кусок `spreadsheet_id`, кусок `title` — резолв через `mpu search`
    (локальный SQLite-кэш `~/.config/mpu/mpu.db`, обновляется через `mpu update`).

Альтернативы fan-out (взаимоисключающи с селектором, и между собой):
  - `--all` — по всем sl-N (N>0) из SQLite-кэша (`mpu init` наполняет `portainer_containers`);
  - `--all-containers <filter>` — по всем контейнерам Portainer-кэша с подстрокой в имени.

JS поступает из (в порядке приоритета):
  1. Позиционный аргумент `code` после селектора (для однострочников);
  2. `--file/-f path/to/script.mjs`;
  3. stdin: pipe (`cat x.mjs | mpu run-js ...`) либо интерактивный TTY с EOF (Ctrl+D).

По умолчанию JS выполняется через `mpu.lib.pssh` (ssh+docker exec или Portainer
HTTP API — выбирается per-server по `~/.config/mpu/.env`; контейнер по имени — всегда
Portainer); при `--dry-run` печатается copy-pasteable `mpu ssh ... -- node ... <<HEREDOC`
блок и копируется в clipboard.

Скрипт исполняется через `node --input-type=module -`, поэтому ему доступны
node_modules sl-back, import aliases (`#bullmq/...`), env (Redis/PG hosts),
`"type": "module"` из `package.json`. Cwd внутри контейнера — корень приложения.

Примеры:
  mpu run-js sl-1 'console.log(1)'
  mpu run-js 12345 'console.log(1)'                    # client_id → server через mpu search
  mpu run-js "Тортуга main" -f script.mjs              # title → server через mpu search
  mpu run-js mp-sl-9-wb-loader 'console.log(1)'        # точное имя контейнера → Portainer
  cat script.mjs | mpu run-js sl-11
  mpu run-js --all 'console.log("on every sl-N")'
  mpu run-js --all-containers wb-loader 'console.log(1)'
"""

import dataclasses
import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import containers, servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.pssh import pssh_run, pssh_run_container
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

COMMAND_NAME = "mpu run-js"
COMMAND_SUMMARY = "Запустить произвольный JS внутри контейнера sl-back по селектору (или --all)"

# Команда, которой кормим JS на каждом сервере: ESM из stdin.
_NODE_CMD = ["node", "--input-type=module", "-"]


app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@dataclasses.dataclass(frozen=True, slots=True)
class _ServerTarget:
    server_number: int


@dataclasses.dataclass(frozen=True, slots=True)
class _ContainerTarget:
    container: str


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


def _resolve_targets(
    selector: str | None,
    all_active: bool,
    all_containers_filter: str | None,
) -> list[_ServerTarget | _ContainerTarget]:
    """Ровно один из (selector | --all | --all-containers) обязателен."""
    modes = [selector is not None, all_active, all_containers_filter is not None]
    if sum(modes) != 1:
        typer.echo(
            f"{COMMAND_NAME}: укажите ровно один из <selector> / --all / --all-containers",
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
        return [_ServerTarget(n) for n in nums]

    if all_containers_filter is not None:
        names = containers.find_containers_by_filter(all_containers_filter)
        if not names:
            typer.echo(
                f"{COMMAND_NAME}: контейнеры с подстрокой {all_containers_filter!r} "
                f"не найдены в кэше; запусти `mpu init`",
                err=True,
            )
            raise typer.Exit(code=2)
        return [_ContainerTarget(n) for n in names]

    assert selector is not None
    # 1. sl-N формат → server target
    n = servers.server_number(selector)
    if n is not None:
        if n < 0:
            typer.echo(f"{COMMAND_NAME}: ожидается sl-N (N>=0), получено: {selector!r}", err=True)
            raise typer.Exit(code=2)
        return [_ServerTarget(n)]
    # 2. Точное имя контейнера в Portainer-кэше
    container_matches = containers.find_container_targets(selector)
    if len(container_matches) == 1:
        return [_ContainerTarget(selector)]
    if len(container_matches) > 1:
        typer.echo(
            f"{COMMAND_NAME}: container {selector!r} ambiguous — "
            f"{len(container_matches)} Portainer endpoints:",
            err=True,
        )
        typer.echo(containers.format_container_candidates(container_matches), err=True)
        raise typer.Exit(code=2)
    # 3. Резолв через mpu search (client_id / spreadsheet_id / title)
    try:
        sn, _candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None
    if sn < 0:
        typer.echo(f"{COMMAND_NAME}: ожидается sl-N (N>=0), получено: {selector!r}", err=True)
        raise typer.Exit(code=2)
    return [_ServerTarget(sn)]


def _build_dry_run_block(targets: list[_ServerTarget | _ContainerTarget], js: str) -> str:
    """Печать `mpu ssh <ref> -- node --input-type=module - <<HEREDOC` блока.

    Одинаково для ssh и Portainer — `mpu ssh` сам выберет транспорт при paste'е.
    `<ref>` — это `sl-N` для серверных таргетов или точное имя контейнера.
    """
    js_body = js.rstrip("\n")
    lines: list[str] = []
    for t in targets:
        if len(targets) > 1:
            label = f"sl-{t.server_number}" if isinstance(t, _ServerTarget) else t.container
            lines.append(f"# target={label}")
        ref = f"sl-{t.server_number}" if isinstance(t, _ServerTarget) else t.container
        lines.append(f"mpu ssh {ref} -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'")
        lines.append(js_body)
        lines.append("__MPU_RUN_JS_EOF__")
    return "\n".join(lines)


@app.command()
def main(
    selector: Annotated[
        str | None,
        typer.Argument(
            help="sl-N | точное имя контейнера | client_id / spreadsheet_id / title "
            "(через mpu search). Взаимоисключающе с --all / --all-containers."
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
    all_containers_filter: Annotated[
        str | None,
        typer.Option(
            "--all-containers",
            help="Fan-out: запустить в всех контейнерах Portainer-кэша с этой подстрокой в имени",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Только напечатать команду(ы) + clipboard, не выполнять"),
    ] = False,
    via: Annotated[
        str | None,
        typer.Option("--via", help="Override транспорта для всех sl-N целей: ssh | portainer"),
    ] = None,
) -> None:
    """Выполнить ESM-код внутри контейнера sl-back через `node --input-type=module -`.

    Селектор `sl-N` / client_id / ss_id / title → код летит в `mp-sl-N-cli`.
    Селектор = точное compose-имя контейнера → Portainer-exec прямо в тот контейнер
    (`mp-sl-N-wb-loader`, `*-instance-app`) — так читают runtime НЕ-cli сервиса.

    Код (приоритет): позиционный <code> → `--file` → stdin. `--all` — fan-out по всем
    sl-N (N>0); `--all-containers <filter>` — fan-out по всем контейнерам с подстрокой
    в имени. При `--all` / `--all-containers` первый позиционный трактуется как <code>.
    `--dry-run` — только напечатать команду(ы) без выполнения.
    """
    # При --all / --all-containers позиционный <selector> не имеет смысла (нет
    # per-server резолва). Repurpose: первый позиционный трактуем как inline-код.
    if (all_active or all_containers_filter is not None) and selector is not None:
        if code is not None:
            typer.echo(
                f"{COMMAND_NAME}: с --all / --all-containers допустим максимум один "
                f"позиционный (<code>); <selector> избыточен",
                err=True,
            )
            raise typer.Exit(code=2)
        code, selector = selector, None

    targets = _resolve_targets(selector, all_active, all_containers_filter)
    js = _resolve_js_source(code=code, file=file)

    if dry_run:
        block = _build_dry_run_block(targets, js)
        typer.echo(block)
        copy_to_clipboard(block)
        return

    labels: list[str] = []
    for t in targets:
        labels.append(f"sl-{t.server_number}" if isinstance(t, _ServerTarget) else t.container)
    typer.echo(f"# {COMMAND_NAME}: targets = [{', '.join(labels)}]", err=True)

    js_bytes = js.encode("utf-8")
    for t in targets:
        label = f"sl-{t.server_number}" if isinstance(t, _ServerTarget) else t.container
        typer.echo(f"# target={label}", err=True)
        if isinstance(t, _ServerTarget):
            rc = pssh_run(server_number=t.server_number, cmd=_NODE_CMD, stdin=js_bytes, via=via)
        else:
            rc = pssh_run_container(container=t.container, cmd=_NODE_CMD, stdin=js_bytes)
        if rc != 0:
            typer.echo(f"{COMMAND_NAME}: {label} exit={rc} — abort", err=True)
            raise typer.Exit(code=rc)
