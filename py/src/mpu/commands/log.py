"""`mpu log` — журнал вызовов самого `mpu` (не логи стенда, для них есть `mpu logs`).

Каждый вызов `mpu` пишет в `~/.config/mpu/mpu.log` одну запись: дата и время, командная
строка, вывод, ошибки, код возврата. Команда и вывод хранятся verbatim — без отступов,
без переформатирования и без чистки ANSI.

Формат записи:

    ### <дата> <время> <смещение> run=<id> pid=<pid> cwd=<каталог>
    $ mpu <команда с аргументами>
    --- note run=<id> ---        # диагностика библиотек (retry, эвикция кэша), если была
    --- out run=<id> ---         # stdout, если был
    --- err run=<id> ---         # stderr, если был
    --- truncated run=<id> stream=out dropped=<байт> ---   # если вывод обрезан
    --- end run=<id> exit=<код> dur=<секунды>s ---

Использование:

    mpu log                              # последние 20 вызовов
    mpu log --tail 100
    mpu log --failed                     # только упавшие (exit != 0)
    mpu log --cmd sql-ro                 # только вызовы `mpu sql-ro …`
    mpu log --since 1h                   # за последний час
    mpu log --run 20260721-163912.345-12345
    mpu log --file ~/.config/mpu/mpu.log.1

Читается весь ротированный набор (`mpu.log.N` … `mpu.log.1`, затем `mpu.log`) как один
поток записей; `--file` ограничивает конкретным файлом.

Grep напрямую (надёжны только якоря с `run=`):

    grep '^### .* run=' -A1 ~/.config/mpu/mpu.log*                  # все вызовы
    grep '^--- end run=.* exit=[^0]' ~/.config/mpu/mpu.log*         # все падения
    grep '^--- err run=' ~/.config/mpu/mpu.log*                     # где был stderr

Голый `^$ ` якорем НЕ является: часть команд (`mp-init`, `copy-client`, `move-client`)
сама печатает в stderr строки-транскрипт `$ docker compose …`, и они попадают в `--- err ---`.

Конфигурация (`~/.config/mpu/.env`):

    MPU_LOG_ENABLED           1 — логировать; 0/off/false/no — выключить логирование целиком
    MPU_LOG_FILE              путь к логу (по умолчанию ~/.config/mpu/mpu.log)
    MPU_LOG_MAX_OUTPUT_BYTES  предел на поток в одной записи, байт (8388608; 0 — без обрезки)
    MPU_LOG_MAX_BYTES         порог ротации, байт (52428800; 0 — не ротировать)
    MPU_LOG_KEEP              сколько mpu.log.N хранить (5; 0 — ротация без архивов)

Лог содержит вывод боевых команд, поэтому создаётся с правами 0600. Вывод `mpu search` и
`mpu api get-token` не пишется вовсе — они печатают живые токены.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import duration
from mpu.lib.cli_err import fail
from mpu.lib.log import log_file_path

COMMAND_NAME = "mpu log"
COMMAND_SUMMARY = "Журнал вызовов mpu: команда, вывод, ошибки, код возврата"

DEFAULT_TAIL = 20

_HEADER_RE = re.compile(
    r"\A### (?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}) run=(?P<run>\S+) "
)
_TS_FORMAT = "%Y-%m-%d %H:%M:%S.%f %z"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=__doc__,
)


@dataclass(frozen=True)
class Record:
    """Одна запись лога: разобранная шапка + сам блок verbatim."""

    run_id: str
    timestamp: float
    command: str
    exit_code: int
    text: str


def log_files(explicit: Path | None = None) -> list[Path]:
    """Файлы лога от старых к новым: `mpu.log.N` … `mpu.log.1`, затем `mpu.log`."""
    if explicit is not None:
        return [explicit]
    base = log_file_path()
    rotated = sorted(
        (path for path in base.parent.glob(f"{base.name}.*") if path.suffix[1:].isdigit()),
        key=lambda path: int(path.suffix[1:]),
        reverse=True,
    )
    return [*rotated, base]


def parse_records(text: str) -> list[Record]:
    """Разобрать содержимое лога в записи.

    Границы берутся по `run=`: блок идёт от своей шапки до `--- end run=<тот же id>`.
    Похожие на маркеры строки внутри чужого вывода не мешают — id не совпадёт.
    """
    records: list[Record] = []
    lines = text.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        header = _HEADER_RE.match(lines[index])
        if header is None:
            index += 1
            continue
        run_id = header.group("run")
        end_prefix = f"--- end run={run_id} "
        block = [lines[index]]
        command = ""
        exit_code = 0
        cursor = index + 1
        while cursor < len(lines):
            line = lines[cursor]
            block.append(line)
            if not command and line.startswith("$ "):
                command = line[2:].rstrip("\n")
            if line.startswith(end_prefix):
                exit_code = _parse_exit(line)
                break
            cursor += 1
        records.append(
            Record(
                run_id=run_id,
                timestamp=_parse_timestamp(header.group("ts")),
                command=command,
                exit_code=exit_code,
                text="".join(block),
            )
        )
        index = cursor + 1
    return records


def _parse_exit(end_line: str) -> int:
    match = re.search(r"exit=(-?\d+)", end_line)
    return int(match.group(1)) if match else 0


def _parse_timestamp(raw: str) -> float:
    try:
        return datetime.strptime(raw, _TS_FORMAT).timestamp()
    except ValueError:
        return 0.0


def _read_records(files: list[Path]) -> list[Record]:
    records: list[Record] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        except OSError as error:
            fail(COMMAND_NAME, f"не прочитать {path}: {error}", code=1)
        records.extend(parse_records(text))
    return records


@app.command()
def main(
    tail: Annotated[
        int, typer.Option("--tail", "-n", help="Сколько последних записей показать")
    ] = DEFAULT_TAIL,
    failed: Annotated[
        bool, typer.Option("--failed", help="Только упавшие вызовы (exit != 0)")
    ] = False,
    cmd: Annotated[
        str | None,
        typer.Option("--cmd", help="Только вызовы этой команды (`sql-ro`, `sheet get`, …)"),
    ] = None,
    since: Annotated[
        str | None,
        typer.Option("--since", help="Relative (10m/1h/30s/2d) или Unix-ts"),
    ] = None,
    run: Annotated[
        str | None, typer.Option("--run", help="Одна запись по её run-id, целиком")
    ] = None,
    file: Annotated[
        Path | None, typer.Option("--file", help="Читать конкретный файл вместо всего набора")
    ] = None,
) -> None:
    """Показать записи журнала вызовов `mpu` (по умолчанию — последние 20)."""
    records = _read_records(log_files(file))

    if run is not None:
        found = [record for record in records if record.run_id == run]
        if not found:
            fail(COMMAND_NAME, f"запись run={run} не найдена", code=1)
        typer.echo(found[-1].text)  # echo дорисовывает пустую строку-разделитель
        return

    if failed:
        records = [record for record in records if record.exit_code != 0]
    if cmd is not None:
        prefix = f"mpu {cmd}"
        records = [record for record in records if record.command.startswith(prefix)]
    if since is not None:
        try:
            threshold = duration.parse_since(since)
        except duration.DurationParseError as error:
            fail(COMMAND_NAME, f"--since: {error}", code=2)
        records = [record for record in records if record.timestamp >= threshold]

    selected = records[-tail:] if tail > 0 else records
    if not selected:
        typer.echo(f"{COMMAND_NAME}: записей не найдено", err=True)
        return
    for record in selected:
        typer.echo(record.text)  # echo дорисовывает пустую строку-разделитель
