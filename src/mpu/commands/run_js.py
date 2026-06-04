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

Режимы выполнения fan-out:
  - по умолчанию — последовательно, abort-on-first-failure, стрим вывода;
  - `--parallel [--jobs N]` — все цели одновременно (N потоков, 0=все), вывод
    группируется по таргету по завершении; гоняет все цели, exit=1 если хоть одна упала;
  - `--detach/-d` — фоновый запуск: скрипт заливается в `/tmp/mpu-run-<id>.mjs` и стартует
    node детачем (вывод → `/tmp/mpu-run-<id>.log`), команда возвращается сразу. Процесс
    переживает закрытие exec/WS/ssh — для долгих прогонов с последующим disconnect.

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
  mpu run-js --all --parallel -f script.mjs           # все sl-N одновременно
  mpu run-js --all --detach -f script.mjs             # фоном на каждом sl-N, вернуться сразу
  mpu run-js --all-containers wb-loader 'console.log(1)'
"""

import concurrent.futures
import dataclasses
import secrets
import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import containers, servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.pssh import (
    detach_script_paths,
    pssh_detach,
    pssh_detach_container,
    pssh_run,
    pssh_run_container,
)
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


def _target_label(t: "_ServerTarget | _ContainerTarget") -> str:
    """Человекочитаемая метка таргета: `sl-N` или точное имя контейнера."""
    return f"sl-{t.server_number}" if isinstance(t, _ServerTarget) else t.container


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


def _run_parallel(
    targets: list[_ServerTarget | _ContainerTarget],
    js_bytes: bytes,
    via: str | None,
    jobs: int,
) -> None:
    """Параллельный fan-out: каждый таргет в своём потоке, вывод буферизуется и
    печатается сгруппированно по мере завершения (без перемешивания строк серверов).

    НЕ abort-on-first-failure (в отличие от последовательного режима) — гоняем все
    таргеты, собираем фейлы, в конце exit=1 если хоть один упал. `manage_signals=False`
    обязателен: `signal.signal` доступен только из главного потока.
    """
    max_workers = jobs if jobs > 0 else len(targets)
    typer.echo(
        f"# {COMMAND_NAME}: parallel — {len(targets)} targets, {max_workers} workers; "
        f"вывод по каждому таргету печатается по его завершении",
        err=True,
    )

    def _one(t: _ServerTarget | _ContainerTarget) -> tuple[int, bytes, bytes]:
        out = bytearray()
        err = bytearray()

        def on_out(b: bytes) -> None:
            out.extend(b)

        def on_err(b: bytes) -> None:
            err.extend(b)

        if isinstance(t, _ServerTarget):
            rc = pssh_run(
                server_number=t.server_number,
                cmd=_NODE_CMD,
                stdin=js_bytes,
                via=via,
                on_stdout=on_out,
                on_stderr=on_err,
                manage_signals=False,
            )
        else:
            rc = pssh_run_container(
                container=t.container,
                cmd=_NODE_CMD,
                stdin=js_bytes,
                on_stdout=on_out,
                on_stderr=on_err,
                manage_signals=False,
            )
        return rc, bytes(out), bytes(err)

    failures: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        fut_to_target = {ex.submit(_one, t): t for t in targets}
        for fut in concurrent.futures.as_completed(fut_to_target):
            label = _target_label(fut_to_target[fut])
            try:
                rc, out, err = fut.result()
            except Exception as e:  # изолируем сбой одного таргета, гоним остальные
                rc, out, err = 1, b"", f"{e}\n".encode()
            typer.echo(f"# ===== {label} (exit={rc}) =====", err=True)
            if out:
                sys.stdout.buffer.write(out)
                sys.stdout.buffer.flush()
            if err:
                sys.stderr.buffer.write(err)
                sys.stderr.buffer.flush()
            if rc != 0:
                failures.append(label)

    if failures:
        typer.echo(f"{COMMAND_NAME}: failures on [{', '.join(failures)}]", err=True)
        raise typer.Exit(code=1)


def _run_detached(
    targets: list[_ServerTarget | _ContainerTarget],
    js_bytes: bytes,
    via: str | None,
) -> None:
    """Фоновый запуск: на каждом таргете залить скрипт и стартовать node детачем.

    Возвращается сразу — node продолжает работать на сервере после disconnect.
    Печатает путь лога на каждом таргете и подсказку, как его потом прочитать.
    Один `run_id` на все таргеты — лог называется одинаково везде.
    """
    run_id = secrets.token_hex(4)
    _, log_path = detach_script_paths(run_id)
    typer.echo(
        f"# {COMMAND_NAME}: detached run_id={run_id} — лог на каждом сервере: {log_path}",
        err=True,
    )

    failures: list[str] = []
    for t in targets:
        label = _target_label(t)
        try:
            if isinstance(t, _ServerTarget):
                rc, log = pssh_detach(
                    server_number=t.server_number, js=js_bytes, run_id=run_id, via=via
                )
            else:
                rc, log = pssh_detach_container(container=t.container, js=js_bytes, run_id=run_id)
        except Exception as e:  # один таргет не должен валить остальные
            typer.echo(f"# {label}: detach FAILED — {e}", err=True)
            failures.append(label)
            continue
        if rc != 0:
            typer.echo(f"# {label}: launch exit={rc}", err=True)
            failures.append(label)
        else:
            typer.echo(f"# {label}: started → {log}", err=True)

    # Подсказка, как собрать логи позже (для server-таргетов через тот же run-js).
    server_labels = [_target_label(t) for t in targets if isinstance(t, _ServerTarget)]
    if server_labels:
        reader = (
            f'import fs from "node:fs"; '
            f'process.stdout.write(fs.existsSync("{log_path}") '
            f'? fs.readFileSync("{log_path}","utf8") : "no log yet\\n")'
        )
        scope = "--all" if len(server_labels) > 1 else server_labels[0]
        typer.echo(f"# собрать логи: mpu run-js {scope} {reader!r}", err=True)
        typer.echo(f"# или вживую: mpu ssh {server_labels[0]} -- tail -f {log_path}", err=True)

    if failures:
        typer.echo(f"{COMMAND_NAME}: detach failures on [{', '.join(failures)}]", err=True)
        raise typer.Exit(code=1)


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
    parallel: Annotated[
        bool,
        typer.Option(
            "--parallel",
            help="Параллельный fan-out по всем целям (для --all / --all-containers): "
            "вывод группируется по таргету; НЕ abort-on-first-failure",
        ),
    ] = False,
    jobs: Annotated[
        int,
        typer.Option("--jobs", "-j", help="Макс. одновременных целей при --parallel (0 = все)"),
    ] = 0,
    detach: Annotated[
        bool,
        typer.Option(
            "--detach",
            "-d",
            help="Фоновый запуск: залить скрипт и стартовать node детачем на каждом таргете, "
            "сразу вернуться. Процесс переживает disconnect; вывод пишется в /tmp лог",
        ),
    ] = False,
) -> None:
    """Выполнить ESM-код внутри контейнера sl-back через `node --input-type=module -`.

    Селектор `sl-N` / client_id / ss_id / title → код летит в `mp-sl-N-cli`.
    Селектор = точное compose-имя контейнера → Portainer-exec прямо в тот контейнер
    (`mp-sl-N-wb-loader`, `*-instance-app`) — так читают runtime НЕ-cli сервиса.

    Код (приоритет): позиционный <code> → `--file` → stdin. `--all` — fan-out по всем
    sl-N (N>0); `--all-containers <filter>` — fan-out по всем контейнерам с подстрокой
    в имени. При `--all` / `--all-containers` первый позиционный трактуется как <code>.
    `--dry-run` — только напечатать команду(ы) без выполнения. `--parallel` — все цели
    одновременно. `--detach/-d` — фоном на сервере (переживает disconnect), вернуться сразу.
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

    labels = [_target_label(t) for t in targets]
    typer.echo(f"# {COMMAND_NAME}: targets = [{', '.join(labels)}]", err=True)

    js_bytes = js.encode("utf-8")

    if detach:
        # Фоновый запуск возвращается сразу — стрим/parallel неприменимы.
        _run_detached(targets, js_bytes, via)
        return

    if parallel and len(targets) > 1:
        _run_parallel(targets, js_bytes, via, jobs)
        return

    for t in targets:
        label = _target_label(t)
        typer.echo(f"# target={label}", err=True)
        if isinstance(t, _ServerTarget):
            rc = pssh_run(server_number=t.server_number, cmd=_NODE_CMD, stdin=js_bytes, via=via)
        else:
            rc = pssh_run_container(container=t.container, cmd=_NODE_CMD, stdin=js_bytes)
        if rc != 0:
            typer.echo(f"{COMMAND_NAME}: {label} exit={rc} — abort", err=True)
            raise typer.Exit(code=rc)
