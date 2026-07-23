"""`mpu ozon-fix-fo-tax <selector>` — фикс завышенного налога на листах ОПиУ / Фин отчет SKU.

Корневая причина — аномальная цена `product_cost_for_customers = 1` (1₽) в сырой
таблице `ozon_postings_reports`. Этот 1₽ занижает налоговую базу
`ozon_realized_without_return` (финреп) и одновременно ломает ставку `tax_total_perc`
(через `ozon10xPricesByDaysAndSkus` → `ozonUnitCalculatedData`).

Пайплайн (последовательно, fail-fast):
  1. (run-js) фикс цен в `ozon_postings_reports`: для каждого sku аномальные строки
     (`product_cost_for_customers = 1`) получают ближайшие предыдущие
     `total_product_cost` / `product_cost_for_customers` / `product_currency_code` /
     `customer_currency_code` (где `product_cost_for_customers <> 1`) через
     `public.find_last_ignore_nulls` (Postgres не умеет `IGNORE NULLS` в LAG).
  2. `ozon-recalculate-expenses` → `ozonUnitCalculatedData.recalculateExpenses`.
  3. `ozon-save-expenses` → `ozonUnitCalculatedData.saveExpenses`
     (пин tax_total_perc/expenses в `ozon_unit_proto.json_data`).
  4. `process --forced --domain ozon` → `dataProcessor.process` (пересбор финреп `ds_*`).
  5. `ss-update` → `ssUpdater.update` (заливка в Google Sheets).

Шаг 1 идёт через run-js (привилегированный коннект `#db/db.js`);
шаги 2–5 — через те же node-CLI вызовы, что и одноимённые standalone-команды.
Бэкапы не делаем (по решению пользователя) — ни `ozon_postings_reports`, ни `ozon_unit_proto`.

`--dry-run` ничего не пишет: run-js делает read-only превью аномалий и печатает SQL,
node-шаги печатаются в stderr без выполнения.
"""

from __future__ import annotations

import datetime
import json
from dataclasses import dataclass
from typing import Annotated

import typer

from mpu.lib import pssh
from mpu.lib.cli_opts import ClientIdOpt, ServerOpt, SpreadsheetIdOpt
from mpu.lib.cli_wrap import (
    FlagValue,
    Resolved,
    auto_pick_int,
    auto_pick_str,
    build_inner_command,
    emit_node_cli,
    require,
    resolve_selector,
)

COMMAND_NAME = "mpu ozon-fix-fo-tax"
COMMAND_SUMMARY = "Фикс 1₽-аномалии в ozon_postings_reports + пересчёт ОПиУ/Фин-отчёт + ss-update"

_DEFAULT_DATE_FROM = "2025-01-01"  # startUnitDate в ozonUnitCalculatedData


@dataclass(frozen=True, slots=True)
class _Step:
    """Шаг сценария: заголовок для stderr + что позвать в node-CLI."""

    title: str
    name: str
    method: str
    flags: dict[str, FlagValue]


def _steps_after_price_fix(
    *, client_id: int, spreadsheet_id: str, date_flags: dict[str, FlagValue]
) -> list[_Step]:
    """Шаги 2–5: пересчёт расходов → пин в proto → forced-пересчёт датасетов → выгрузка листа.

    Порядок важен: каждый следующий читает результат предыдущего.
    """
    return [
        _Step(
            "step 2: ozonUnitCalculatedData.recalculateExpenses",
            "ozonUnitCalculatedData",
            "recalculateExpenses",
            {"--client-id": client_id, **date_flags},
        ),
        _Step(
            "step 3: ozonUnitCalculatedData.saveExpenses",
            "ozonUnitCalculatedData",
            "saveExpenses",
            {"--client-id": client_id, **date_flags},
        ),
        _Step(
            "step 4: dataProcessor.process --forced --domain ozon",
            "dataProcessor",
            "process",
            {
                "--client-id": client_id,
                "--spreadsheet-id": spreadsheet_id,
                "--forced": True,
                "--domain": "ozon",
                **date_flags,
            },
        ),
        _Step(
            "step 5: ssUpdater.update",
            "ssUpdater",
            "update",
            {
                "--client-id": client_id,
                "--spreadsheet-id": spreadsheet_id,
                "--update-type": "schedule",
                "--logs": "info",
            },
        ),
    ]


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _ranked_cte(schema: str) -> str:
    """CTE `ranked`: для каждой строки — ближайшая предыдущая (строго раньше по
    accepted_for_processing) цена того же sku, где product_cost_for_customers <> 1.
    Все 4 поля forward-fill'ятся по ОДНОМУ условию → берутся с одного постинга."""
    return f"""WITH ranked AS (
  SELECT
    posting_number, sku, product_cost_for_customers,
    public.find_last_ignore_nulls(
      CASE WHEN product_cost_for_customers <> 1 THEN total_product_cost END
    ) OVER w AS pv_total,
    public.find_last_ignore_nulls(
      CASE WHEN product_cost_for_customers <> 1 THEN product_cost_for_customers END
    ) OVER w AS pv_cost,
    public.find_last_ignore_nulls(
      CASE WHEN product_cost_for_customers <> 1 THEN product_currency_code END
    ) OVER w AS pv_pcur,
    public.find_last_ignore_nulls(
      CASE WHEN product_cost_for_customers <> 1 THEN customer_currency_code END
    ) OVER w AS pv_ccur
  FROM {schema}.ozon_postings_reports
  WINDOW w AS (PARTITION BY sku ORDER BY accepted_for_processing ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
)"""


def _fix_sql(schema: str) -> str:
    return f"""{_ranked_cte(schema)}
UPDATE {schema}.ozon_postings_reports AS o
   SET total_product_cost         = r.pv_total,
       product_cost_for_customers = r.pv_cost,
       product_currency_code      = r.pv_pcur,
       customer_currency_code     = r.pv_ccur
  FROM ranked r
 WHERE o.posting_number = r.posting_number AND o.sku = r.sku
   AND o.product_cost_for_customers = 1
   AND r.pv_cost IS NOT NULL"""


def _preview_sql(schema: str) -> str:
    return f"""{_ranked_cte(schema)}
SELECT
  count(*) FILTER (WHERE product_cost_for_customers = 1)                        AS anomalies,
  count(*) FILTER (WHERE product_cost_for_customers = 1 AND pv_cost IS NOT NULL) AS fixable,
  count(*) FILTER (WHERE product_cost_for_customers = 1 AND pv_cost IS NULL)     AS no_prev_valid
FROM ranked"""


def _build_js(*, client_id: int, dry_run: bool) -> str:
    """ESM-скрипт для run-js: фикс цен в ozon_postings_reports (или read-only превью при dry)."""
    schema = f"schema_{client_id}"
    body = """
import { db } from "#db/db.js";

const DRY = __DRY__;
const FIX_SQL = __FIX__;
const PREVIEW_SQL = __PREVIEW__;
const tag = (...a) => console.log("[ozon-fix-fo-tax]", ...a);

try {
  if (DRY) {
    const p = await db.raw(PREVIEW_SQL);
    tag("DRY preview:", JSON.stringify(p.rows[0]));
    tag("DRY would run UPDATE:\\n" + FIX_SQL);
  } else {
    const res = await db.raw(FIX_SQL);
    tag(`patched ${res.rowCount} ozon_postings_reports row(s)`);
  }
  process.exit(0);
} catch (e) {
  console.error("[ozon-fix-fo-tax]", (e && e.stack) || e);
  process.exit(1);
}
"""
    return (
        body.replace("__DRY__", "true" if dry_run else "false")
        .replace("__FIX__", json.dumps(_fix_sql(schema)))
        .replace("__PREVIEW__", json.dumps(_preview_sql(schema)))
    )


def _node_step(
    *,
    name: str,
    method: str,
    flags: dict[str, FlagValue],
    resolved: Resolved,
    dry_run: bool,
) -> None:
    """Один node-CLI шаг: dry — печать inner-команды в stderr; иначе exec через Portainer.

    `emit_node_cli(wrapper="portainer")` сам бросает `typer.Exit(rc)` при ненулевом коде —
    это и есть fail-fast для всей цепочки.
    """
    if dry_run:
        inner = build_inner_command(
            name=name, method=method, flags=flags, command_name=COMMAND_NAME
        )
        typer.echo(f"#   would run: {inner}", err=True)
        return
    emit_node_cli(
        name=name,
        method=method,
        flags=flags,
        resolved=resolved,
        wrapper="portainer",
        command_name=COMMAND_NAME,
    )


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, title substring, или sl-N"),
    ],
    server: ServerOpt = None,
    client_id: ClientIdOpt = None,
    spreadsheet_id: SpreadsheetIdOpt = None,
    date_from: Annotated[
        str,
        typer.Option("--date-from", "--date_from", help="Начальная дата пересчёта (YYYY-MM-DD)"),
    ] = _DEFAULT_DATE_FROM,
    date_to: Annotated[
        str | None,
        typer.Option(
            "--date-to",
            "--date_to",
            help="Конечная дата пересчёта (YYYY-MM-DD); по умолчанию — сегодня",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run", "--dry_run", help="Только показать план; ничего не выполнять/писать"
        ),
    ] = False,
) -> None:
    """Починить источник 1₽ и прогнать штатную цепочку пересчёта ОПиУ / Фин отчет SKU."""
    resolved = resolve_selector(
        value=selector, server=server, command_name=COMMAND_NAME, require_ssh=False
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    ssid = require(
        spreadsheet_id
        if spreadsheet_id is not None
        else auto_pick_str(resolved.candidates, "spreadsheet_id"),
        flag="--spreadsheet-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    dt_to = date_to or datetime.date.today().isoformat()

    typer.echo(
        f"# {COMMAND_NAME}: sl-{resolved.server_number} client_id={cid} ss={ssid} "
        f"range={date_from}..{dt_to} dry_run={dry_run}",
        err=True,
    )

    # ── Шаг 1: фикс цен в ozon_postings_reports через run-js (привилегированный #db/db.js) ──
    typer.echo("# step 1: fix ozon_postings_reports prices", err=True)
    js = _build_js(client_id=cid, dry_run=dry_run)
    rc = pssh.pssh_run(
        server_number=resolved.server_number,
        cmd=["node", "--input-type=module", "-"],
        stdin=js.encode("utf-8"),
    )
    if rc != 0:
        typer.echo(f"{COMMAND_NAME}: price-fix step failed (rc={rc})", err=True)
        raise typer.Exit(code=rc)

    date_flags: dict[str, FlagValue] = {"--date-from": date_from, "--date-to": dt_to}
    for step in _steps_after_price_fix(client_id=cid, spreadsheet_id=ssid, date_flags=date_flags):
        typer.echo(f"# {step.title}", err=True)
        _node_step(
            name=step.name,
            method=step.method,
            flags=step.flags,
            resolved=resolved,
            dry_run=dry_run,
        )

    typer.echo(f"# {COMMAND_NAME}: done", err=True)
