"""Фабрика typer-команд для семейства "client-id + date-from/to + опциональный nm-ids".

Печатает ssh-команду формата:
    ssh -i <key> -t <user>@<sl_ip> 'docker exec -it mp-sl-N-cli sh -c
        "node cli service:<service> <method>
            --client-id <id> --date-from <df> --date-to <dt>[ --nm-ids <nms>]"'

Команда только выводится в stdout, не выполняется — пользователь сам копирует и запускает.
Селектор — то же, что у `mpu-search` (client_id / spreadsheet_id substring / title substring).

С флагом `--local` обёртка меняется на `sl-N-cli sh -c "..."` (alias из mp-config-local).

Боль реализации: фабрика держит две typer-функции (с `--nm-ids` и без), потому
что typer определяет CLI-сигнатуру по аннотациям параметров — выкинуть один параметр
условно нельзя без рантайм-DSL'а.
"""

import datetime
from typing import Annotated

import typer

from mpu.lib.cli_wrap import (
    auto_pick_int,
    emit_node_cli,
    require,
    resolve_selector,
)


def _emit(
    *,
    service: str,
    method: str,
    command_name: str,
    value: str,
    server: str | None,
    local: bool,
    client_id: int | None,
    date_from: str,
    date_to: str | None,
    nm_ids: str | None,
) -> None:
    resolved = resolve_selector(
        value=value, server=server, command_name=command_name, require_ssh=not local
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=command_name,
    )
    dt_to = date_to or datetime.date.today().isoformat()
    emit_node_cli(
        name=service,
        method=method,
        flags={
            "--client-id": cid,
            "--date-from": date_from,
            "--date-to": dt_to,
            "--nm-ids": nm_ids,
        },
        resolved=resolved,
        wrapper="local" if local else "ssh",
        command_name=command_name,
    )


def make_app(
    *,
    service: str,
    method: str,
    command_name: str,
    include_nm_ids: bool = False,
) -> typer.Typer:
    """Сделать typer-app для одной из вариаций команды.

    `service` — имя сервиса в `node cli service:<service>` (например `wbUnitCalculatedData`,
        `dataProcessor`).
    `method` — имя метода (как ожидает sl-back CLI).
    `command_name` — `mpu-...` для сообщений об ошибках в stderr.
    `include_nm_ids` — если True, добавить опцию `--nm-ids` (для wbUnitCalculatedData).
    """
    app = typer.Typer(
        no_args_is_help=True,
        context_settings={"help_option_names": ["-h", "--help"]},
    )

    if include_nm_ids:

        @app.command()
        def main_with_nm_ids(  # pyright: ignore[reportUnusedFunction]
            value: Annotated[
                str,
                typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
            ],
            server: Annotated[
                str | None, typer.Option("--server", help="Override резолва: sl-N")
            ] = None,
            local: Annotated[
                bool,
                typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)"),
            ] = False,
            client_id: Annotated[
                int | None,
                typer.Option(
                    "--client-id",
                    "--client_id",
                    help="Override client_id если selector неоднозначен",
                ),
            ] = None,
            date_from: Annotated[
                str,
                typer.Option("--date-from", "--date_from", help="Начальная дата (YYYY-MM-DD)"),
            ] = "2025-01-01",
            date_to: Annotated[
                str | None,
                typer.Option(
                    "--date-to",
                    "--date_to",
                    help="Конечная дата (YYYY-MM-DD); по умолчанию — сегодня",
                ),
            ] = None,
            nm_ids: Annotated[
                str | None,
                typer.Option(
                    "--nm-ids",
                    "--nm_ids",
                    help="Список nm_ids, например [1,2,3] (без пробелов)",
                ),
            ] = None,
        ) -> None:
            """Распечатать ssh-команду в stdout (без выполнения)."""
            _emit(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
                local=local,
                client_id=client_id,
                date_from=date_from,
                date_to=date_to,
                nm_ids=nm_ids,
            )

    else:

        @app.command()
        def main_no_nm_ids(  # pyright: ignore[reportUnusedFunction]
            value: Annotated[
                str,
                typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
            ],
            server: Annotated[
                str | None, typer.Option("--server", help="Override резолва: sl-N")
            ] = None,
            local: Annotated[
                bool,
                typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)"),
            ] = False,
            client_id: Annotated[
                int | None,
                typer.Option(
                    "--client-id",
                    "--client_id",
                    help="Override client_id если selector неоднозначен",
                ),
            ] = None,
            date_from: Annotated[
                str,
                typer.Option("--date-from", "--date_from", help="Начальная дата (YYYY-MM-DD)"),
            ] = "2025-01-01",
            date_to: Annotated[
                str | None,
                typer.Option(
                    "--date-to",
                    "--date_to",
                    help="Конечная дата (YYYY-MM-DD); по умолчанию — сегодня",
                ),
            ] = None,
        ) -> None:
            """Распечатать ssh-команду в stdout (без выполнения)."""
            _emit(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
                local=local,
                client_id=client_id,
                date_from=date_from,
                date_to=date_to,
                nm_ids=None,
            )

    return app
