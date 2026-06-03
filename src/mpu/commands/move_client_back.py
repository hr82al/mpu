"""`mpu move-client-back` — вернуть клиента на исходный sl-сервер / управлять историей.

Обратная к `mpu move-client`: читает последний записанный ход клиента из SQLite-таблицы
`client_moves` (см. `mpu.lib.client_moves`) и переносит его обратно — реверс source↔target.
После успешного обратного переноса запись удаляется.

Формы (первый позиционный аргумент — диспетчер):
- `mpu move-client-back <selector>` — реверс одного клиента (selector как у `move-client`:
  client_id / spreadsheet_id / title / sl-N).
- `mpu move-client-back ls` (или без аргументов) — показать незавершённые ходы.
- `mpu move-client-back rm <selector>` — удалить запись хода клиента из истории (без переноса).

`ls` / `rm` — зарезервированные ключевые слова: клиент с таким селектором недоступен через
эту команду напрямую (используй client_id).
"""

import time
from typing import Annotated

import typer

from mpu.lib import servers
from mpu.lib.client_moves import Move, clear_move, last_move, list_moves
from mpu.lib.client_transfer import run_transfer
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

COMMAND_NAME = "mpu move-client-back"
COMMAND_SUMMARY = "Вернуть клиента на исходный sl-сервер (ls — список, rm — удалить запись)"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _resolve_client_id(selector: str) -> int:
    """Селектор → client_id. Чистый int — это сразу client_id (без обращения к кэшу,
    робастно к устаревшему/непрогретому search-кэшу); иначе резолв через `mpu search`."""
    try:
        return int(selector)
    except ValueError:
        pass

    try:
        _server_n, candidates = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    ids = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    if not ids:
        typer.echo(
            f"{COMMAND_NAME}: selector {selector!r} не указывает на конкретного клиента",
            err=True,
        )
        if candidates:
            typer.echo(format_candidates(candidates), err=True)
        raise typer.Exit(code=2)
    if len(ids) > 1:
        typer.echo(
            f"{COMMAND_NAME}: selector matches {len(ids)} clients — narrow it down",
            err=True,
        )
        typer.echo(format_candidates(candidates), err=True)
        raise typer.Exit(code=2)
    return next(iter(ids))


def _print_moves(moves: list[Move]) -> None:
    if not moves:
        typer.echo("нет записанных ходов")
        return
    id_w = max(len("client_id"), *(len(str(m["client_id"])) for m in moves))
    typer.echo(f"{'client_id'.ljust(id_w)}  перенос (откуда → куда)  когда")
    for m in moves:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["moved_at"]))
        route = f"{m['source']} → {m['target']}"
        typer.echo(f"{str(m['client_id']).ljust(id_w)}  {route.ljust(23)}  {when}")


def _do_remove(selector: str) -> None:
    """`rm <selector>` — удалить запись хода клиента из истории (перенос не выполняется)."""
    client_id = _resolve_client_id(selector)
    move = last_move(client_id)
    if move is None:
        typer.echo(f"{COMMAND_NAME}: нет записи хода для client {client_id}", err=True)
        return
    clear_move(client_id)
    typer.echo(
        f"{COMMAND_NAME}: удалена запись хода client {client_id}: "
        f"{move['source']} → {move['target']}"
    )


def _do_reverse(selector: str) -> None:
    """`<selector>` — перенести клиента обратно по последней записи `move-client`."""
    client_id = _resolve_client_id(selector)
    move = last_move(client_id)
    if move is None:
        typer.echo(
            f"{COMMAND_NAME}: нет записанного хода для client {client_id} "
            f"(сначала `mpu move-client`, либо запусти `mpu init`)",
            err=True,
        )
        raise typer.Exit(code=2)

    # Реверс: сейчас клиент на move.target, возвращаем на move.source.
    cur_n = servers.server_number(move["target"])
    home_n = servers.server_number(move["source"])
    if cur_n is None or home_n is None:
        typer.echo(
            f"{COMMAND_NAME}: повреждённая запись хода: {move['source']} → {move['target']}",
            err=True,
        )
        raise typer.Exit(code=2)
    if cur_n == home_n:
        typer.echo(
            f"{COMMAND_NAME}: source и target записи оба sl-{cur_n} — нечего возвращать",
            err=True,
        )
        raise typer.Exit(code=2)

    typer.echo(
        f"{COMMAND_NAME}: возврат client {client_id}: sl-{cur_n} → sl-{home_n} "
        f"(записанный ход: sl-{home_n} → sl-{cur_n})",
        err=True,
    )
    rc = run_transfer(COMMAND_NAME, client_id, source_n=cur_n, target_n=home_n)
    if rc == 0:
        clear_move(client_id)
    raise typer.Exit(code=rc)


@app.command()
def main(
    action: Annotated[
        str | None,
        typer.Argument(
            metavar="[SELECTOR|ls|rm]",
            help="selector — реверс клиента; `ls` — список ходов; `rm` — удалить запись",
        ),
    ] = None,
    selector: Annotated[
        str | None,
        typer.Argument(metavar="[SELECTOR]", help="селектор клиента для `rm`"),
    ] = None,
) -> None:
    """Реверс переноса по записи `move-client`; `ls` — список, `rm <selector>` — удалить запись."""
    if action is None or action in ("ls", "list"):
        _print_moves(list_moves())
        return

    if action == "rm":
        if selector is None:
            typer.echo(f"{COMMAND_NAME}: `rm` требует селектор (rm <selector>)", err=True)
            raise typer.Exit(code=2)
        _do_remove(selector)
        return

    _do_reverse(action)
