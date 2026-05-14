"""`mpu sql` — выполнить SQL на удалённом PG, выбираемом по селектору.

Селектор — то же, что у `mpu search` (client_id / spreadsheet_id substring / title substring).

SQL берётся (в порядке приоритета):
  1. Аргумент после селектора.
  2. stdin (если не TTY).
  3. Интерактивный multi-line ввод до EOF (Ctrl+D).
"""

import sys
from typing import Annotated

import typer

from mpu.lib import sql_runner
from mpu.lib.resolver import ResolveError, resolve_server

COMMAND_NAME = "mpu sql"
COMMAND_SUMMARY = "Выполнить SQL на удалённом PG по селектору"


def _format_candidates(candidates: list[dict[str, object]]) -> str:
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


def _read_sql(sql_arg: str | None) -> str:
    if sql_arg is not None and sql_arg.strip():
        return sql_arg
    if not sys.stdin.isatty():
        return sys.stdin.read()
    print("-- enter SQL, end with EOF (Ctrl+D):", file=sys.stderr)
    return sys.stdin.read()


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str, typer.Argument(help="client_id, spreadsheet_id substring, или title substring")
    ],
    sql: Annotated[
        str | None,
        typer.Argument(help="SQL для выполнения; если не задан — берётся из stdin"),
    ] = None,
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    dry: Annotated[bool, typer.Option("--dry", help="Только meta + SQL, без коннекта")] = False,
    json_out: Annotated[
        bool, typer.Option("--json", help="Результат как JSON-array объектов")
    ] = False,
    md_out: Annotated[
        bool, typer.Option("--md", help="Результат как markdown-таблица")
    ] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "-v", "--verbose", help="Печатать meta-блок (server, host, db, search_path, SQL)"
        ),
    ] = False,
) -> None:
    if json_out and md_out:
        typer.echo("mpu sql: --json и --md взаимоисключающие", err=True)
        raise typer.Exit(code=2)

    try:
        server_number, candidates = resolve_server(selector, server_override=server)
    except ResolveError as e:
        typer.echo(f"mpu sql: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    sql_text = _read_sql(sql)
    if not sql_text.strip():
        typer.echo("mpu sql: empty SQL", err=True)
        raise typer.Exit(code=2)

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
    )
    raise typer.Exit(code=code)
