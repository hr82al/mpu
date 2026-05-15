"""`mpu process` — обёртка для dataProcessor.process.

Дефолт — выполнение через Portainer; `--print` / `-p` возвращает в print + clipboard.

Опциональные флаги (из sl-back-метода `dataProcessor.process` + pass-through в
`dataset.prepareData`/`getClientsDatasetsList`):
  --domain wb|ozon            фильтр датасетов по домену
  --dataset NAME              один датасет
  --datasets NAME [...]       список датасетов (повторяемый)
  --modules NAME [...]        списки модулей (повторяемый)
  --exclude-datasets NAME ... (повторяемый)
  --exclude-modules NAME ...  (повторяемый)
  --with-tags TAG [...]       фильтр по тегам (повторяемый; autocomplete)
  --without-tags TAG [...]    исключить теги (повторяемый; autocomplete)
  --no-deps                   не подтягивать зависимости
  --forced                    скип логики «что пересчитать»
  --forced-update             всегда обновлять строку (skip JSONB-сравнение)
  --dry-run                   только логировать SQL, не выполнять
  --sid SID                   ozon/wb cabinet sid
  --nm-ids '[1,2,3]'          WB nm_ids (JSON-литерал, без пробелов)
  --skus 1 [--skus 2 ...]     Ozon SKU (повторяемый; live autocomplete)
  --logs LEVEL                override log.level
  -v / --verbose              печать собранной inner-команды в stderr

Tab-complete:
  --date-from / --date-to     2025-01-01 / сегодня
  --domain                    wb / ozon
  --logs                      error / warn / info / debug / trace
  --with-tags / --without-tags source / derived / analytics / load / update / persistent / wb / ozon
  --skus                      live SELECT DISTINCT sku из ozon_unit_proto
"""

import datetime
from typing import Annotated

import typer

from mpu.lib import pg
from mpu.lib.cli_wrap import (
    FlagValue,
    auto_pick_int,
    auto_pick_str,
    emit_node_cli,
    pick_wrapper,
    require,
    resolve_selector,
)
from mpu.lib.resolver import resolve_server

COMMAND_NAME = "mpu process"
COMMAND_SUMMARY = "dataProcessor.process (выполнение через Portainer; --print для печати)"


# datasets.constants.js → DATASET_TAGS (lowercase string values).
_TAGS: tuple[str, ...] = (
    "source",
    "derived",
    "analytics",
    "load",
    "update",
    "persistent",
    "wb",
    "ozon",
)
_DOMAINS: tuple[str, ...] = ("wb", "ozon")
_LOGS_LEVELS: tuple[str, ...] = ("error", "warn", "info", "debug", "trace")


def _complete_tag(incomplete: str) -> list[str]:
    return [t for t in _TAGS if t.startswith(incomplete)]


def _complete_domain(incomplete: str) -> list[str]:
    return [d for d in _DOMAINS if d.startswith(incomplete)]


def _complete_logs_level(incomplete: str) -> list[str]:
    return [lvl for lvl in _LOGS_LEVELS if lvl.startswith(incomplete)]


def _complete_today(incomplete: str) -> list[str]:
    today = datetime.date.today().isoformat()
    return [today] if today.startswith(incomplete) else []


def _complete_date_from(incomplete: str) -> list[str]:
    return ["2025-01-01"] if "2025-01-01".startswith(incomplete) else []


def _complete_sku(ctx: typer.Context, incomplete: str) -> list[str]:
    """Live SELECT DISTINCT sku из ozon_unit_proto клиента (silent [] на ошибки)."""
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


def _avoid_singleton_collapse_str(values: list[str]) -> list[str]:
    """sl-back parseMethodArgs коллапсит --flag X (одно значение) в скаляр.

    Для string-array параметров (datasets / modules / exclude_* / *_tags), которые
    обрабатываются циклом `for (const x of arr)` — итерация по строке даёт буквы,
    что ломает логику. Дублируем при len==1 → массив `["A", "A"]`, для Set/Map-семантик
    эквивалентен `["A"]`.
    """
    return values * 2 if len(values) == 1 else values


def _join_int_bracket(values: list[int] | None) -> str | None:
    """Список чисел → single JSON-литерал `[1,2,3]` (без пробелов).

    sl-back-парсер (cli.runner.js:tryToParseJson) распознаёт чисто. Работает и для
    single-value `[5]` (без collapse-бага, т.к. tryToParseJson возвращает массив).
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
            "--client-id", "--client_id",
            help="Override client_id если selector неоднозначен",
        ),
    ] = None,
    spreadsheet_id: Annotated[
        str | None,
        typer.Option(
            "--spreadsheet-id", "--spreadsheet_id",
            help="Override spreadsheet_id если selector неоднозначен",
        ),
    ] = None,
    date_from: Annotated[
        str | None,
        typer.Option(
            "--date-from", "--date_from",
            help="Начальная дата (YYYY-MM-DD)",
            autocompletion=_complete_date_from,
        ),
    ] = None,
    date_to: Annotated[
        str | None,
        typer.Option(
            "--date-to", "--date_to",
            help="Конечная дата (YYYY-MM-DD)",
            autocompletion=_complete_today,
        ),
    ] = None,
    domain: Annotated[
        str | None,
        typer.Option(
            "--domain",
            help="Фильтр датасетов по домену (wb / ozon)",
            autocompletion=_complete_domain,
        ),
    ] = None,
    dataset: Annotated[
        str | None,
        typer.Option("--dataset", help="Один датасет по имени"),
    ] = None,
    datasets: Annotated[
        list[str] | None,
        typer.Option("--datasets", help="Список датасетов (повторяемый)"),
    ] = None,
    modules: Annotated[
        list[str] | None,
        typer.Option("--modules", help="Список модулей (повторяемый)"),
    ] = None,
    exclude_datasets: Annotated[
        list[str] | None,
        typer.Option(
            "--exclude-datasets", "--exclude_datasets",
            help="Исключить датасеты (повторяемый)",
        ),
    ] = None,
    exclude_modules: Annotated[
        list[str] | None,
        typer.Option(
            "--exclude-modules", "--exclude_modules",
            help="Исключить модули (повторяемый)",
        ),
    ] = None,
    with_tags: Annotated[
        list[str] | None,
        typer.Option(
            "--with-tags", "--with_tags",
            help="Фильтр по тегам — нужны ВСЕ указанные (повторяемый)",
            autocompletion=_complete_tag,
        ),
    ] = None,
    without_tags: Annotated[
        list[str] | None,
        typer.Option(
            "--without-tags", "--without_tags",
            help="Исключить теги — НИ ОДИН из указанных (повторяемый)",
            autocompletion=_complete_tag,
        ),
    ] = None,
    no_deps: Annotated[
        bool,
        typer.Option("--no-deps", "--no_deps", help="Не подтягивать зависимости рекурсивно"),
    ] = False,
    forced: Annotated[
        bool,
        typer.Option("--forced", help="Скип логики «что пересчитать» в parseParams"),
    ] = False,
    forced_update: Annotated[
        bool,
        typer.Option(
            "--forced-update", "--forced_update",
            help="Всегда обновлять строку в upsert (skip JSONB-сравнения)",
        ),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", "--dry_run", help="Только логировать SQL, не выполнять"),
    ] = False,
    sid: Annotated[
        str | None,
        typer.Option("--sid", help="Cabinet sid (WB seller cabinet или Ozon seller_client_id)"),
    ] = None,
    nm_ids: Annotated[
        str | None,
        typer.Option(
            "--nm-ids", "--nm_ids",
            help="WB nm_ids как JSON-литерал, например [1,2,3] (без пробелов)",
        ),
    ] = None,
    skus: Annotated[
        list[int] | None,
        typer.Option(
            "--skus",
            help="Ozon SKU(s); повторяемый: --skus 1 --skus 2",
            autocompletion=_complete_sku,
        ),
    ] = None,
    logs: Annotated[
        str | None,
        typer.Option(
            "--logs",
            help="Override log.level (error/warn/info/debug/trace)",
            autocompletion=_complete_logs_level,
        ),
    ] = None,
    verbose: Annotated[
        bool,
        typer.Option(
            "-v", "--verbose",
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
    # spreadsheet_id опционально; если selector однозначно резолвится в один — подставим.
    ssid = (
        spreadsheet_id
        if spreadsheet_id is not None
        else auto_pick_str(resolved.candidates, "spreadsheet_id")
    )

    flags: dict[str, FlagValue] = {
        "--client-id": cid,
        "--spreadsheet-id": ssid,
        "--date-from": date_from,
        "--date-to": date_to,
        "--domain": domain,
        "--dataset": dataset,
        "--datasets": _avoid_singleton_collapse_str(datasets) if datasets else None,
        "--modules": _avoid_singleton_collapse_str(modules) if modules else None,
        "--exclude-datasets": (
            _avoid_singleton_collapse_str(exclude_datasets) if exclude_datasets else None
        ),
        "--exclude-modules": (
            _avoid_singleton_collapse_str(exclude_modules) if exclude_modules else None
        ),
        "--with-tags": _avoid_singleton_collapse_str(with_tags) if with_tags else None,
        "--without-tags": _avoid_singleton_collapse_str(without_tags) if without_tags else None,
        "--no-deps": no_deps,
        "--forced": forced,
        "--forced-update": forced_update,
        "--dry-run": dry_run,
        "--sid": sid,
        "--nm-ids": nm_ids,
        "--skus": _join_int_bracket(skus),
        "--logs": logs,
    }

    if verbose:
        from mpu.lib.cli_wrap import _build_inner  # private helper, ok inside package

        inner = _build_inner(
            entry="cli",
            type_="service",
            name="dataProcessor",
            method="process",
            flags=flags,
            command_name=COMMAND_NAME,
        )
        typer.echo(f"# inner: {inner}", err=True)

    emit_node_cli(
        name="dataProcessor",
        method="process",
        flags=flags,
        resolved=resolved,
        wrapper=wrapper,
        command_name=COMMAND_NAME,
    )
