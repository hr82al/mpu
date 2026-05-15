"""`mpu ozon-recalculate-expenses` — обёртка для ozonUnitCalculatedData.recalculateExpenses.

Дефолт — выполнение через Portainer; `--print` / `-p` возвращает в print + clipboard.

Опциональные флаги (из sl-back-метода `ozonUnitCalculatedDataService.recalculateExpenses`):
  --ref-date YYYY-MM-DD       дата-источник для changeRefData
  --ref-fields F [-F ...]     поля для копирования из ref_date (повторяемый)
  --skus N [--skus M ...]     SKU-фильтр (повторяемый)
  --logs-level LEVEL          override log.level
  -v / --verbose              печать собранной inner-команды в stderr

Tab-complete:
  --date-from / --date-to / --ref-date — подсказка (2025-01-01 / сегодня)
  --ref-fields                          — 13 known-полей из changeRefData
  --logs-level                          — error/warn/info/debug/trace
  --skus                                — live SELECT DISTINCT sku из ozon_unit_proto
"""

import datetime
from typing import Annotated

import typer

from mpu.lib import pg
from mpu.lib.cli_wrap import (
    auto_pick_int,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)
from mpu.lib.resolver import resolve_server

COMMAND_NAME = "mpu ozon-recalculate-expenses"
COMMAND_SUMMARY = "ozonUnitCalculatedData.recalculateExpenses (выполнение через Portainer; --print для печати)"


# Default-набор из ozonUnitCalculatedDataService.changeRefData
# (sl-back/src/datasets/ozon/ozonUnitCalculatedData/ozonUnitCalculatedData.service.js:237-253).
# Обновлять синхронно с sl-back.
_REF_FIELDS: tuple[str, ...] = (
    "sebes_rub",
    "markirovka_rub",
    "promo_discount_perc",
    "my_promo_card_perc",
    "additional_costs",
    "tax",
    "vat_perc",
    "perc_daily_payment",
    "width",
    "depth",
    "height",
    "per_day_storage_fee",
    "tax_type",
)
_LOGS_LEVELS: tuple[str, ...] = ("error", "warn", "info", "debug", "trace")


def _complete_ref_field(incomplete: str) -> list[str]:
    return [f for f in _REF_FIELDS if f.startswith(incomplete)]


def _complete_logs_level(incomplete: str) -> list[str]:
    return [lvl for lvl in _LOGS_LEVELS if lvl.startswith(incomplete)]


def _complete_today(incomplete: str) -> list[str]:
    """Подсказка: сегодняшняя дата YYYY-MM-DD. Юзер TAB'ом получает её и при желании правит."""
    today = datetime.date.today().isoformat()
    return [today] if today.startswith(incomplete) else []


def _complete_date_from(incomplete: str) -> list[str]:
    """Подсказка: дефолт `2025-01-01`."""
    return ["2025-01-01"] if "2025-01-01".startswith(incomplete) else []


def _complete_sku(ctx: typer.Context, incomplete: str) -> list[str]:
    """Live-запрос distinct sku из ozon_unit_proto. silent [] на любую ошибку."""
    selector = ctx.params.get("value")
    if not isinstance(selector, str) or not selector:
        return []
    try:
        server_number, candidates = resolve_server(selector, server_override=None)
    except Exception:  # noqa: BLE001 — TAB completion must not raise
        return []
    cids = {cid for c in candidates if isinstance(cid := c.get("client_id"), int)}
    if len(cids) != 1:
        return []
    client_id = next(iter(cids))
    safe_prefix = "".join(ch for ch in incomplete if ch.isdigit())
    sql = (
        f'SELECT DISTINCT sku FROM "schema_{client_id}".ozon_unit_proto '
        f"WHERE sku::text LIKE %s ORDER BY sku LIMIT 50"
    )
    try:
        with pg.connect_to(server_number, timeout=2) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (safe_prefix + "%",))
                return [str(row[0]) for row in cur.fetchall()]
    except Exception:  # noqa: BLE001
        return []


def _avoid_singleton_collapse(values: list[str]) -> list[str]:
    """sl-back parseMethodArgs коллапсит `--flag X` (одно значение) в скаляр,
    а `changeRefData` ждёт массив (`.map(field => ...)`). Дублируем при len==1.
    Дубликат безопасен: `json_build_object` с одинаковым ключом дважды → PG
    оставляет одну запись.
    """
    return values * 2 if len(values) == 1 else values


def _join_int_bracket(values: list[int] | None) -> str | None:
    """SKUs эмитим как single JSON-литерал `[1,2,3]` (без пробелов).

    sl-back-парсер (cli.runner.js) распознаёт через `tryToParseJson` и кладёт в
    `skus` массив. Для строк это не работает (без кавычек невалидный JSON),
    но целочисленные массивы парсятся чисто, в т.ч. для одиночного `[N]`.
    """
    if not values:
        return None
    return "[" + ",".join(str(v) for v in values) + "]"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    value: Annotated[
        str,
        typer.Argument(help="client_id, spreadsheet_id substring, или title substring"),
    ],
    server: Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")] = None,
    local: Annotated[
        bool, typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)")
    ] = False,
    print_mode: Annotated[
        bool,
        typer.Option("--print", "-p", help="Печатать обёртку в stdout + clipboard, не выполнять"),
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
        typer.Option(
            "--date-from",
            "--date_from",
            help="Начальная дата (YYYY-MM-DD)",
            autocompletion=_complete_date_from,
        ),
    ] = "2025-01-01",
    date_to: Annotated[
        str | None,
        typer.Option(
            "--date-to",
            "--date_to",
            help="Конечная дата (YYYY-MM-DD); по умолчанию — сегодня",
            autocompletion=_complete_today,
        ),
    ] = None,
    ref_date: Annotated[
        str | None,
        typer.Option(
            "--ref-date",
            "--ref_date",
            help="Дата-источник для changeRefData (YYYY-MM-DD)",
            autocompletion=_complete_today,
        ),
    ] = None,
    ref_fields: Annotated[
        list[str] | None,
        typer.Option(
            "--ref-fields",
            "--ref_fields",
            help="Поля для копирования из ref_date; повторяемый: --ref-fields A --ref-fields B",
            autocompletion=_complete_ref_field,
        ),
    ] = None,
    skus: Annotated[
        list[int] | None,
        typer.Option(
            "--skus",
            help="SKU(s); повторяемый: --skus 1 --skus 2",
            autocompletion=_complete_sku,
        ),
    ] = None,
    logs_level: Annotated[
        str | None,
        typer.Option(
            "--logs-level",
            "--logs_level",
            help="Override log.level (error/warn/info/debug/trace)",
            autocompletion=_complete_logs_level,
        ),
    ] = None,
    verbose: Annotated[
        bool,
        typer.Option(
            "-v",
            "--verbose",
            help="Печатать собранную inner-команду в stderr перед выполнением",
        ),
    ] = False,
) -> None:
    """Выполнить через Portainer; `--print` — печать обёртки без выполнения."""
    wrapper, require_ssh = pick_wrapper(print_mode=print_mode, local=local)
    resolved = resolve_selector(
        value=value, server=server, command_name=COMMAND_NAME, require_ssh=require_ssh
    )
    cid = require(
        client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
        flag="--client-id",
        candidates=resolved.candidates,
        command_name=COMMAND_NAME,
    )
    dt_to = date_to or datetime.date.today().isoformat()

    flags = {
        "--client-id": cid,
        "--date-from": date_from,
        "--date-to": dt_to,
        "--ref-date": ref_date,
        "--ref-fields": _avoid_singleton_collapse(ref_fields) if ref_fields else None,
        "--skus": _join_int_bracket(skus),
        "--logs-level": logs_level,
    }

    if verbose:
        # _build_inner — приватный helper из mpu.lib.cli_wrap. Используем для
        # верификационной печати inner-команды без выполнения.
        from mpu.lib.cli_wrap import _build_inner

        inner = _build_inner(
            entry="cli",
            type_="service",
            name="ozonUnitCalculatedData",
            method="recalculateExpenses",
            flags=flags,
            command_name=COMMAND_NAME,
        )
        typer.echo(f"# inner: {inner}", err=True)

    emit_node_cli(
        name="ozonUnitCalculatedData",
        method="recalculateExpenses",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
