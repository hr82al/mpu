"""Общая логика для команд, печатающих ssh-обёртку над `node cli service:<X> <method>`.

Печатает ssh-команду формата:
    ssh -i <key> -t <user>@<sl_ip> 'docker exec -it mp-sl-N-cli sh -c
        "node cli service:<service> <method>
            --client-id <id> --date-from <df> --date-to <dt>[ --nm-ids <nms>]"'

Команда только выводится в stdout, не выполняется — пользователь сам копирует и запускает.
Селектор — то же, что у `mpu-search` (client_id / spreadsheet_id substring / title substring).
"""

import datetime
import re
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.resolver import ResolveError, resolve_server

# Whitelist для значений, попадающих в shell-обёртку.
# Запрещаем spaces, $, `, ', ", \, ;, &, |, (, ) — инвариант quoting'а строится на их отсутствии.
_SAFE_TOKEN = re.compile(r"\A[A-Za-z0-9_./:\-,\[\]]+\Z")


def format_candidates(candidates: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for c in candidates:
        client_id = c.get("client_id")
        server = c.get("server")
        title = c.get("title")
        ss = c.get("spreadsheet_id")
        parts = [f"client_id={client_id}", f"server={server}"]
        if title:
            parts.append(f'title="{title}"')
        if ss:
            parts.append(f"spreadsheet_id={ss}")
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)


def pick_client_id(candidates: list[dict[str, object]]) -> int | None:
    distinct = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    return next(iter(distinct)) if len(distinct) == 1 else None


def pick_spreadsheet_id(candidates: list[dict[str, object]]) -> str | None:
    distinct = {ss for c in candidates if isinstance(ss := c.get("spreadsheet_id"), str)}
    return next(iter(distinct)) if len(distinct) == 1 else None


def check_safe(flag: str, value: str) -> None:
    if not _SAFE_TOKEN.fullmatch(value):
        raise typer.BadParameter(
            f"value contains shell-unsafe chars: {value!r}",
            param_hint=flag,
        )


def build_ssh_command(
    *,
    service: str,
    method: str,
    server_number: int,
    sl_ip: str,
    user: str,
    client_id: int,
    date_from: str,
    date_to: str,
    nm_ids: str | None,
) -> str:
    """Собрать готовую ssh-строку. Все входы предполагаются прошедшими `check_safe`."""
    key_path = str(Path.home() / ".ssh" / "id_rsa")
    container = f"mp-sl-{server_number}-cli"
    inner_args = [
        "node",
        "cli",
        f"service:{service}",
        method,
        "--client-id",
        str(client_id),
        "--date-from",
        date_from,
        "--date-to",
        date_to,
    ]
    if nm_ids is not None:
        inner_args += ["--nm-ids", nm_ids]
    inner = " ".join(inner_args)
    docker_block = f'docker exec -it {container} sh -c "{inner}"'
    return f"ssh -i {key_path} -t {user}@{sl_ip} '{docker_block}'"


def _run_print(
    *,
    service: str,
    method: str,
    command_name: str,
    value: str,
    server: str | None,
    client_id: int | None,
    date_from: str,
    date_to: str | None,
    nm_ids: str | None,
) -> None:
    try:
        server_number, candidates = resolve_server(value, server_override=server)
    except ResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    cid = client_id if client_id is not None else pick_client_id(candidates)
    if cid is None:
        typer.echo(
            f"{command_name}: cannot resolve client_id from selector; pass --client-id",
            err=True,
        )
        if candidates:
            typer.echo(format_candidates(candidates), err=True)
        raise typer.Exit(code=2)

    ip = servers.sl_ip(server_number)
    if ip is None:
        typer.echo(
            f"{command_name}: no sl_{server_number} in ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)

    user = servers.env_value("PG_MY_USER_NAME")
    if not user:
        typer.echo(
            f"{command_name}: PG_MY_USER_NAME not set in ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)

    dt_to = date_to or datetime.date.today().isoformat()

    check_safe("--date-from", date_from)
    check_safe("--date-to", dt_to)
    if nm_ids is not None:
        check_safe("--nm-ids", nm_ids)

    cmd = build_ssh_command(
        service=service,
        method=method,
        server_number=server_number,
        sl_ip=ip,
        user=user,
        client_id=cid,
        date_from=date_from,
        date_to=dt_to,
        nm_ids=nm_ids,
    )
    typer.echo(cmd)
    copy_to_clipboard(cmd)


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
                typer.Option(
                    "--date-from", "--date_from", help="Начальная дата (YYYY-MM-DD)"
                ),
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
            _run_print(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
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
                typer.Option(
                    "--date-from", "--date_from", help="Начальная дата (YYYY-MM-DD)"
                ),
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
            _run_print(
                service=service,
                method=method,
                command_name=command_name,
                value=value,
                server=server,
                client_id=client_id,
                date_from=date_from,
                date_to=date_to,
                nm_ids=None,
            )

    return app
