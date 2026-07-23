"""`mpu sql` — выполнить SQL на удалённом PG, выбираемом по селектору.

Селектор — то же, что у `mpu search` (client_id / spreadsheet_id substring / title substring),
либо sw-PG алиас (`sw` / `sw-pg` / `ws` / `workspaces` / `sw-back`) — база sw-back
`workspaces`: SQL выполняется ВНУТРИ контейнера sw-back (механизм `mpu run-js`),
коннект к PG идёт изнутри по `DATABASE_URL` контейнера (prod sw-PG закрыт
`pg_hba` на внешние хосты). Таргет — `SW_PG_RUN_TARGET` (default `sw-api`),
см. `mpu.lib.sql_sw`.

SQL берётся (в порядке приоритета):
  1. Аргумент после селектора.
  2. stdin (если не TTY).
  3. Интерактивный multi-line ввод до EOF (Ctrl+D).
"""

import sys
from typing import Annotated

import typer

from mpu.lib import servers, sql_runner, sql_sw
from mpu.lib.cli_opts import ServerOpt
from mpu.lib.resolver import resolve_server_or_exit

COMMAND_NAME = "mpu sql"
COMMAND_SUMMARY = "Выполнить SQL на удалённом PG по селектору"


def _read_sql(sql_arg: str | None) -> str:
    if sql_arg is not None and sql_arg.strip():
        return sql_arg
    if not sys.stdin.isatty():
        return sys.stdin.read()
    print("-- enter SQL, end with EOF (Ctrl+D):", file=sys.stderr)
    return sys.stdin.read()


def _read_sql_or_exit(sql_arg: str | None, prog: str) -> str:
    """SQL из аргумента/stdin; пустой → сообщение + `typer.Exit(2)`."""
    text = _read_sql(sql_arg)
    if not text.strip():
        typer.echo(f"{prog}: empty SQL", err=True)
        raise typer.Exit(code=2)
    return text


def _reject_server_override(server: str | None, prog: str, *, kind: str) -> None:
    """`--server` не сочетается с dev-/sw-селектором (у них свой транспорт)."""
    if server:
        typer.echo(f"{prog}: --server не сочетается с {kind}", err=True)
        raise typer.Exit(code=2)


def dispatch(  # noqa: PLR0913
    selector: str,
    sql: str | None,
    *,
    server: str | None,
    dry: bool,
    json_out: bool,
    md_out: bool,
    verbose: bool,
    read_only: bool,
    prog: str,
) -> None:
    """Общее тело `mpu sql` и `mpu sql-ro`. `read_only` прокидывается в исполнители
    (enforced PG read-only), `prog` — имя команды для текста ошибок. Бросает `typer.Exit`.

    Три исполнителя по виду селектора: `dev:<client_id>` → dev-нода, sw-алиас →
    контейнер sw-back, иначе — резолв в sl-N через `mpu search`.
    """
    if json_out and md_out:
        typer.echo(f"{prog}: --json и --md взаимоисключающие", err=True)
        raise typer.Exit(code=2)

    if (dev_rest := servers.parse_dev_selector(selector)) is not None:
        _reject_server_override(server, prog, kind="dev-селектором")
        rest = dev_rest.strip()
        code = sql_runner.run_sql(
            0,
            _read_sql_or_exit(sql, prog),
            client_id=int(rest) if rest.isdigit() else None,
            dev=True,
            dry=dry,
            json_out=json_out,
            md_out=md_out,
            verbose=verbose,
            read_only=read_only,
        )
        raise typer.Exit(code=code)

    if sql_sw.is_sw_selector(selector):
        _reject_server_override(server, prog, kind="sw-селектором")
        code = sql_sw.run_sql_sw(
            _read_sql_or_exit(sql, prog),
            dry=dry,
            json_out=json_out,
            md_out=md_out,
            verbose=verbose,
            read_only=read_only,
        )
        raise typer.Exit(code=code)

    server_number, candidates = resolve_server_or_exit(
        selector, server_override=server, command_name=prog
    )

    sql_text = _read_sql_or_exit(sql, prog)

    # Если все кандидаты указывают на одного клиента — ставим search_path
    # на schema_<client_id>, чтобы запросы могли обращаться к таблицам без префикса.
    distinct_client_ids = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    client_id = next(iter(distinct_client_ids)) if len(distinct_client_ids) == 1 else None

    code = sql_runner.run_sql(
        server_number,
        sql_text,
        client_id=client_id,
        dry=dry,
        json_out=json_out,
        md_out=md_out,
        verbose=verbose,
        read_only=read_only,
    )
    raise typer.Exit(code=code)


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="client_id, spreadsheet_id substring, title substring, "
            "sw-PG алиас (sw / sw-pg / ws / workspaces), "
            "или dev-стенд `dev:<client_id>` (БД mp_sl_1_dev, search_path schema_<client_id>)"
        ),
    ],
    sql: Annotated[
        str | None,
        typer.Argument(help="SQL для выполнения; если не задан — берётся из stdin"),
    ] = None,
    server: ServerOpt = None,
    dry: Annotated[bool, typer.Option("--dry", help="Только meta + SQL, без коннекта")] = False,
    json_out: Annotated[
        bool, typer.Option("--json", help="Результат как JSON-array объектов")
    ] = False,
    md_out: Annotated[bool, typer.Option("--md", help="Результат как markdown-таблица")] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "-v", "--verbose", help="Печатать meta-блок (server, host, db, search_path, SQL)"
        ),
    ] = False,
) -> None:
    dispatch(
        selector,
        sql,
        server=server,
        dry=dry,
        json_out=json_out,
        md_out=md_out,
        verbose=verbose,
        read_only=False,
        prog=COMMAND_NAME,
    )
