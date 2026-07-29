"""Фабрика typer-команд для семейства "client-id + date-from/to + опциональный nm-ids".

Печатает ssh-команду формата:
    ssh -i <key> -t <user>@<sl_ip> 'docker exec -it sl-N-cli sh -c
        "node cli service:<service> <method>
            --client-id <id> --date-from <df> --date-to <dt>[ --nm-ids <nms>]"'

Команда только выводится в stdout, не выполняется — пользователь сам копирует и запускает.
Селектор — то же, что у `mpu search` (client_id / spreadsheet_id substring / title substring).

С флагом `--local` обёртка меняется на `sl-N-cli sh -c "..."` (alias из mp-config-local).

Боль реализации: фабрика держит две typer-функции (с `--nm-ids` и без), потому
что typer определяет CLI-сигнатуру по аннотациям параметров — выкинуть один параметр
условно нельзя без рантайм-DSL'а.
"""

import datetime
from typing import Annotated

import typer

from mpu.lib.cli_opts import ClientIdOpt, LocalOpt, PrintOpt, SelectorArg, ServerOpt
from mpu.lib.cli_wrap import (
    emit_node_cli,
    pick_client_id,
    pick_wrapper,
    resolve_selector,
)


def _emit(  # noqa: PLR0913
    *,
    service: str,
    method: str,
    command_name: str,
    value: str,
    server: str | None,
    local: bool,
    print_mode: bool,
    client_id: int | None,
    date_from: str,
    date_to: str | None,
    nm_ids: str | None,
) -> None:
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=command_name, require_ssh=require_ssh
    )
    cid = pick_client_id(resolved, client_id, command_name=command_name)
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
        wrapper=wrapper,
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
            value: SelectorArg,
            server: ServerOpt = None,
            local: LocalOpt = False,
            print_mode: PrintOpt = False,
            client_id: ClientIdOpt = None,
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
            """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
            _emit(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
                local=local,
                print_mode=print_mode,
                client_id=client_id,
                date_from=date_from,
                date_to=date_to,
                nm_ids=nm_ids,
            )

    else:

        @app.command()
        def main_no_nm_ids(  # pyright: ignore[reportUnusedFunction]
            value: SelectorArg,
            server: ServerOpt = None,
            local: LocalOpt = False,
            print_mode: PrintOpt = False,
            client_id: ClientIdOpt = None,
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
            """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
            _emit(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
                local=local,
                print_mode=print_mode,
                client_id=client_id,
                date_from=date_from,
                date_to=date_to,
                nm_ids=None,
            )

    return app
