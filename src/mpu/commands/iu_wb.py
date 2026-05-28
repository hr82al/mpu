"""`mpu iu-wb <команда> <selector>` — группа команд ИУ для WB.

Подкоманды (selector — аргумент КАЖДОЙ подкоманды, чтобы `mpu iu-wb <tab>` дополнял команды):
  get-source-data <selector>            service:iuWb getSourceData (node-CLI wrapper).
  make-sql <selector> [json]            SQL простановки ИУ в wb_unit_manual_data из [{nm_id, perc}].
  fix-formulas <selector> [json]        JSON [{range, formula}] для листа UNIT (мердж ИУ в I6/S4).

Селектор: `sl-N` либо client_id / spreadsheet_id substring / title substring.
"""

from __future__ import annotations

import datetime
import json
from typing import Annotated, Any, cast

import psycopg
import typer
from psycopg import sql

from mpu.lib import pg
from mpu.lib.cli_wrap import (
    auto_pick_int,
    auto_pick_str,
    complete_selector,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)
from mpu.lib.iu_common import read_iu_input
from mpu.lib.iu_formula import merge_iu_perc, merge_iu_zero
from mpu.lib.iu_sql import build_iu_sql
from mpu.lib.sheet_api import SheetApiError, WebappClient

COMMAND_NAME = "mpu iu-wb"
COMMAND_SUMMARY = "ИУ для WB: get-source-data / make-sql / fix-formulas"
_SEL_HELP = "sl-N либо client_id / spreadsheet_id substring / title substring"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)

_Selector = Annotated[str, typer.Argument(help=_SEL_HELP, autocompletion=complete_selector)]
_Payload = Annotated[
    str | None, typer.Argument(help="JSON [{nm_id, perc}] (если не задан — читается из stdin)")
]


@app.command(name="get-source-data")
def get_source_data(
    selector: _Selector,
    local: Annotated[bool, typer.Option("--local", help="Local form: sl-N-cli (без ssh)")] = False,
    print_mode: Annotated[
        bool, typer.Option("--print", "-p", help="Печать обёртки в stdout, не выполнять")
    ] = False,
) -> None:
    """Распечатать/выполнить service:iuWb getSourceData."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=selector, server=None, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    emit_node_cli(
        name="iuWb",
        method="getSourceData",
        flags={},
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )


def _check_date(label: str, value: str) -> None:
    try:
        datetime.date.fromisoformat(value)
    except ValueError as e:
        typer.echo(f"{COMMAND_NAME}: {label} ожидается YYYY-MM-DD, получено {value!r}", err=True)
        raise typer.Exit(2) from e


def _client_id(selector: str) -> tuple[int, str | None, int]:
    """resolve_selector → (client_id, spreadsheet_id|None, server_number). require_ssh=False."""
    resolved = resolve_selector(
        value=selector, server=None, command_name=COMMAND_NAME, require_ssh=False
    )
    client_id = require(
        auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    ss_id = auto_pick_str(resolved.candidates, "spreadsheet_id")
    return client_id, ss_id, resolved.server_number


@app.command(name="make-sql")
def make_sql(
    selector: _Selector,
    payload: _Payload = None,
    date_from: Annotated[
        str, typer.Option("--date-from", help="начало периода YYYY-MM-DD")
    ] = "2025-01-01",
    date_to: Annotated[
        str | None,
        typer.Option("--date-to", help="конец периода YYYY-MM-DD (по умолчанию — сегодня)"),
    ] = None,
    proto_table: Annotated[
        str, typer.Option("--proto-table", help="таблица-источник nm_id в схеме клиента")
    ] = "wb_unit_proto_new",
) -> None:
    """Напечатать SQL ИУ (wb_unit_manual_data) из `[{nm_id, perc}]`. Ничего не выполняет."""
    rows = read_iu_input(payload, command_name=COMMAND_NAME)
    client_id, _ss, _srv = _client_id(selector)
    effective_to = date_to or datetime.date.today().isoformat()
    _check_date("--date-from", date_from)
    _check_date("--date-to", effective_to)
    typer.echo(
        build_iu_sql(
            schema=f"schema_{client_id}",
            proto_table=proto_table,
            date_from=date_from,
            date_to=effective_to,
            rows=rows,
        )
    )


def _resolve_subjects_and_targets(
    server_number: int, client_id: int, proto_table: str, rows: list[tuple[int, float]]
) -> tuple[dict[str, float], list[int]]:
    """Из БД: subject_name на входной nm_id (→ subject_perc, первый perc на категорию) и
    полный список nm_id целевых категорий ∩ proto-таблица (для S4)."""
    input_nm_ids = [nm for nm, _ in rows]
    conn = pg.connect_to(server_number)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                sql.SQL("SET search_path TO {}, shared, public").format(
                    sql.Identifier(f"schema_{client_id}")
                )
            )
            cur.execute(
                "SELECT DISTINCT ON (wc.nm_id) wc.nm_id, wbs.subject_name "
                "FROM wb_cards wc JOIN shared.wb_subjects wbs USING (subject_id) "
                "WHERE wc.nm_id = ANY(%s) "
                "ORDER BY wc.nm_id, wc.updated_at DESC NULLS LAST",
                (input_nm_ids,),
            )
            subj_by_nm: dict[int, str] = {
                int(r[0]): str(r[1]) for r in cur.fetchall() if r[1] is not None
            }
            unresolved = [nm for nm in input_nm_ids if nm not in subj_by_nm]
            if unresolved:
                typer.echo(
                    f"{COMMAND_NAME}: nm_id без subject в wb_cards/shared.wb_subjects: "
                    f"{unresolved}",
                    err=True,
                )
                raise typer.Exit(2)
            subject_perc: dict[str, float] = {}
            for nm, perc in rows:
                subject_perc.setdefault(subj_by_nm[nm], perc)
            cur.execute(
                sql.SQL(
                    "SELECT DISTINCT wc.nm_id FROM wb_cards wc "
                    "JOIN shared.wb_subjects wbs USING (subject_id) "
                    "WHERE wbs.subject_name = ANY(%s) "
                    "AND wc.nm_id IN (SELECT nm_id FROM {proto}) "
                    "ORDER BY wc.nm_id"
                ).format(proto=sql.Identifier(proto_table)),
                (list(subject_perc.keys()),),
            )
            target_nm_ids = [int(r[0]) for r in cur.fetchall()]
        return subject_perc, target_nm_ids
    except psycopg.Error as e:
        typer.echo(f"{COMMAND_NAME}: db error: {e}", err=True)
        raise typer.Exit(1) from e
    finally:
        conn.close()


def _read_unit_formulas(ss_id: str, i_cell: str, s_cell: str) -> tuple[str, str]:
    """Прямой batchGet двух ячеек с FORMULA-render (без whole-tab кэша — он медленный на UNIT)."""
    try:
        api = WebappClient.from_env()
        resp = api.batch_get(
            ss_id, [f"UNIT!{i_cell}", f"UNIT!{s_cell}"], value_render="FORMULA"
        )
    except SheetApiError as e:
        typer.echo(f"{COMMAND_NAME}: sheet: {e}", err=True)
        raise typer.Exit(1) from e
    vrs = cast("list[Any]", resp.get("valueRanges") or [])

    def _cell(idx: int) -> str:
        if idx >= len(vrs):
            return ""
        vals = cast("list[Any]", vrs[idx].get("values") or [])
        if vals and vals[0] and vals[0][0] is not None:
            return str(vals[0][0])
        return ""

    return _cell(0), _cell(1)


@app.command(name="fix-formulas")
def fix_formulas(
    selector: _Selector,
    payload: _Payload = None,
    proto_table: Annotated[
        str, typer.Option("--proto-table", help="таблица-источник nm_id в схеме клиента")
    ] = "wb_unit_proto_new",
    i_from: Annotated[int, typer.Option("--i-from", help="первая строка колонки I")] = 6,
    s_cell: Annotated[str, typer.Option("--s-cell", help="ячейка формулы 2")] = "S4",
) -> None:
    """Напечатать JSON [{range, formula}] для UNIT: мердж ИУ в формулы I (subject) и S4 (nm_id)."""
    rows = read_iu_input(payload, command_name=COMMAND_NAME)
    client_id, ss_id_opt, server_number = _client_id(selector)
    ss_id = require(
        ss_id_opt,
        flag="--spreadsheet-id",
        candidates=[],
        command_name=COMMAND_NAME,
    )
    subject_perc, target_nm_ids = _resolve_subjects_and_targets(
        server_number, client_id, proto_table, rows
    )
    cur_i, cur_s = _read_unit_formulas(ss_id, f"I{i_from}", s_cell)
    out = [
        {"range": f"UNIT!I{i_from}:I", "formula": merge_iu_perc(cur_i, subject_perc)},
        {"range": f"UNIT!{s_cell}", "formula": merge_iu_zero(cur_s, target_nm_ids)},
    ]
    typer.echo(json.dumps(out, ensure_ascii=False))
