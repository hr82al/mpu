"""Каталог переиспользуемых typer-опций (CLAUDE.md, принцип 8.2).

Опция, объявленная больше одного раза, живёт здесь одним `Annotated`-алиасом: команда пишет
`server: ServerOpt = None` вместо шести строк декларации. Это и короче, и лечит настоящую болезнь
копий — разъезжающийся `--help`: до выноса один и тот же селектор описывался в командах
пятью разными фразами.

Использование:

    from mpu.lib.cli_opts import ClientIdOpt, PrintOpt, SelectorArg

    @app.command()
    def main(
        value: SelectorArg, client_id: ClientIdOpt = None, print_mode: PrintOpt = False
    ) -> None: ...

Значение по умолчанию задаёт вызывающий (алиас несёт только тип и метаданные typer). Опция,
которая нужна одной группе команд, а не всему CLI, объявляется рядом с ней
(`commands/_<группа>.py`), а не здесь.

Модуль грузится жадно вместе со всеми командами — держать его без тяжёлых импортов.
"""

from typing import Annotated

import typer

SelectorArg = Annotated[
    str,
    typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
]

ServerOpt = Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")]

LocalOpt = Annotated[
    bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
]

PrintOpt = Annotated[
    bool,
    typer.Option("--print", "-p", help="Печатать обёртку в stdout + clipboard, не выполнять"),
]

ClientIdOpt = Annotated[
    int | None,
    typer.Option(
        "--client-id",
        "--client_id",
        help="Override client_id если selector неоднозначен",
    ),
]

SpreadsheetIdOpt = Annotated[
    str | None,
    typer.Option(
        "--spreadsheet-id",
        "--spreadsheet_id",
        help="Override spreadsheet_id если selector неоднозначен",
    ),
]

JsonOpt = Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")]
