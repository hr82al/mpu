"""Общие хелперы команд `mpu api` для управления wb-loader-app загрузчиками.

Контейнер wb-loader-app держит загрузчики per-SID; sl-back main проксирует
`/admin/wb-loader/<rest>` → wb-main `/api/<rest>`, а wb-main маршрутизирует
`/api/loaders/:sid/<entity>/v1/*` на инстанс, владеющий SID (стандартные роуты
`registerStandardLoaderRoutes`,
`sl-back/src/wbLoaderInstanceApp/wbLoaders/standardLoaderRoutes.js`). POST'ы
гейтятся `wbLoaderWriteGate` (роль `support_write`+).

Здесь — переиспользуемые куски, на которых строятся команды wb-loader-status /
wb-loader-reset / wb-loader-load / wb-cards-reset / wb-loader-resume: резолв sid
по селектору `mpu search`, валидация loader-слага, построение пути, curl-эмиттер
для `--print`, машинно-читаемые ошибки.
"""

from __future__ import annotations

import json
import re
from typing import TypeGuard

import click

# re-export `fail`/`print_json`: команды wb-loader-семейства исторически импортируют их отсюда
from mpu.lib.cli_err import fail as fail
from mpu.lib.cli_out import print_json as print_json
from mpu.lib.cli_wrap import auto_pick_int
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

# Каноническая карта загрузчиков wb-loader-app: camelCase-имя → kebab-слаг.
# Источник истины — sl-back `WB_LOADERS` (`WB_*_LOADER` константы) + `entity:` в
# `wbLoaders/*/*Loader.router.js` (`wbLoaderInstanceApp.constants.js`). Порядок = как
# в `WB_LOADERS`. ВСЕ они — per-sid state machine и любой может уйти в `blocked`.
#   • camelCase — как в `wb_loaders_info.loader` и фильтре blocked-loaders; его ждут
#     `wb-loader-blocked` / `wb-loader-resume`.
#   • kebab — как в URL стандартных loader-роутов `/status` `/load` `/reset`; его ждут
#     `wb-loader-status` / `wb-loader-load` / `wb-loader-reset`.
# Единый источник: из него выводятся `LOADER_ENTITIES` (kebab), обратная карта и
# `LOADER_REFERENCE_HELP`. При добавлении загрузчика в sl-back — дополнить здесь.
LOADERS: dict[str, str] = {
    "wbCards": "cards",
    "wbOrders": "orders",
    "wbSales": "sales",
    "wbReports": "reports",
    "wbAnalytics": "analytics",
    "wbFeedbacks": "feedbacks",
    "wbAdvertsDetailed": "adverts-detailed",
    "wbSearchTexts": "search-texts",
    "wbSupplies": "supplies",
    "wbAnalyticsStocks": "analytics-stocks",
    "wbAcceptanceReports": "acceptance-reports",
    "wbPrices": "prices",
    "wbPaidStorage": "paid-storage",
    "wbSellerInfo": "seller-info",
    "wbAdvBudget": "adv-budget",
    "wbFbsWarehouses": "fbs-warehouses",
    "wbFbsStocks": "fbs-stocks",
    "wbAdvUpd": "adv-upd",
    "wbAdvFullstats": "adv-fullstats",
    "wbAdvNormqueryStats": "adv-normquery-stats",
    "wbAdvNormqueryStatsByDates": "adv-normquery-stats-by-dates",
    "wbSearchClustersBids": "search-clusters-bids",
    "wbTariffsBox": "tariffs-box",
    "wbTariffsPallet": "tariffs-pallet",
    "wbTariffsCommissions": "tariffs-commissions",
}

# camelCase-имена (blocked/resume) и kebab-слаги (status/load/reset), выведенные из
# единой карты `LOADERS` — не расходятся по построению.
LOADER_NAMES: list[str] = list(LOADERS)
LOADER_ENTITIES: list[str] = sorted(LOADERS.values())
# kebab-слаг → camelCase-имя: для подсказки «не та форма» между командами.
LOADER_NAME_BY_ENTITY: dict[str, str] = {entity: name for name, entity in LOADERS.items()}


def _build_loader_reference_help() -> str:
    """Единая справка-приложение по загрузчикам — добавляется в `--help` каждой
    `wb-loader-*` команды, чтобы полный список и обе формы имени были под рукой без
    похода в код. `\\b` в начале держит блок нерасформатированным (click)."""
    pairs = "\n".join(f"    {name:<28}{entity}" for name, entity in LOADERS.items())
    return (
        "\n\n\b\n"
        "── ЗАГРУЗЧИКИ · справка для всех wb-loader-* команд ──\n"
        "Имя загрузчика существует в ДВУХ формах; команды принимают РАЗНЫЕ:\n"
        "  wb-loader-status / -load / -reset  → kebab-слаг   (cards, fbs-stocks …)\n"
        "  wb-loader-blocked / -resume        → camelCase имя (wbCards, wbFbsStocks …)\n"
        "Все 25 — per-sid state machine, любой уходит в blocked. Карта camelCase → kebab:\n"
        f"{pairs}\n"
        "blocked_reason · operational (сами восстановятся, resume не нужен):\n"
        "  no_token, cards_not_loaded, cards_filter_not_ready, adverts_detailed_not_loaded,\n"
        "  fbs_warehouses_not_loaded, feature_disabled, endpoint_forbidden\n"
        "blocked_reason · permanent (сам не восстановится, нужен wb-loader-resume):\n"
        "  invalid_token, payment_required, response_parse_error, dto_mapping_error,\n"
        "  db_write_error, unexpected_http_status, network_error, paid_storage_recreate_limit,\n"
        "  not_using, unknown_error\n"
        "Типовой разлок заблокированного загрузчика (пример wbCards / cards):\n"
        "  1) wb-loader-resume <sel>          показать blocked + причину (read-only)\n"
        "  2) wb-loader-resume <sel> wbCards  снять блок (роль support_write+)\n"
        "  3) wb-loader-load   <sel> cards    прогнать сейчас, не ждать цикла\n"
        "  4) wb-loader-status <sel> cards    проверить: status=idle, blocked_reason=null\n"
    )


LOADER_REFERENCE_HELP: str = _build_loader_reference_help()

# Forward-only загрузчики: state хранит `lastLoadedDate`, окно идёт
# `lastLoadedDate+1 → вчера`, провалы сами не догоняются. Для них
# `mpu api wb-loader-reset --from` собирает `{state:{lastLoadedDate: from-1}}`.
# Источник: handleIdle загрузчика (wbAdvNormqueryStatsLoader.js).
FORWARD_ONLY_ENTITIES: frozenset[str] = frozenset({"adv-normquery-stats"})

# UUID-форма WB sid (8-4-4-4-12 hex).
SID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def looks_like_sid(value: str) -> bool:
    """`value` — полный WB sid (UUID-форма) → работаем по sid напрямую."""
    return bool(SID_RE.match(value))


def complete_entity(ctx: click.Context, param: click.Parameter, incomplete: str) -> list[str]:
    """Shell-автодополнение loader-слага по `LOADER_ENTITIES`."""
    _ = ctx, param
    return [e for e in LOADER_ENTITIES if e.startswith(incomplete)]


def wrong_form_hint(value: str) -> str | None:
    """Если `value` — тот же загрузчик, но в форме для ДРУГОГО набора команд,
    вернуть подсказку с правильной формой; иначе None (обычная опечатка).

    `status`/`load`/`reset` ждут kebab (`cards`), а `blocked`/`resume` — camelCase
    (`wbCards`). Хелпер детектит, какую форму передали, и советует противоположную —
    убирает «лишний шаг» при путанице форм между командами.
    """
    if value in LOADERS:  # camelCase передан туда, где ждут kebab
        return f"используй kebab-слаг: {LOADERS[value]}"
    if value in LOADER_NAME_BY_ENTITY:  # kebab передан туда, где ждут camelCase
        return f"используй camelCase-имя: {LOADER_NAME_BY_ENTITY[value]}"
    return None


def loader_path(sid: str, entity: str, action: str) -> str:
    """Путь к стандартному loader-роуту через main-прокси `/admin/wb-loader`.

    sl-back main `/admin/wb-loader/<rest>` → wb-main `/api/<rest>`; `v1` обязателен.
    """
    return f"/admin/wb-loader/loaders/{sid}/{entity}/v1/{action}"


# Явные TypeGuard'ы для границы JSON-ответа (CLAUDE.md §5 — type-guard, не cast/Any).
def is_obj_list(o: object) -> TypeGuard[list[object]]:
    return isinstance(o, list)


def is_str_dict(o: object) -> TypeGuard[dict[str, object]]:
    return isinstance(o, dict)


def as_list(value: object, *, what: str, command: str) -> list[object]:  # noqa: RET503 — fail() NoReturn, ruff не видит через импорт
    """Ответ-поле должно быть JSON-массивом, иначе exit 1."""
    if is_obj_list(value):
        return value
    fail(command, f"{what}: ожидался JSON-массив, получено {type(value).__name__}", code=1)


def as_dict(value: object, *, what: str, command: str) -> dict[str, object]:  # noqa: RET503 — fail() NoReturn, ruff не видит через импорт
    """Ответ-поле должно быть JSON-объектом, иначе exit 1."""
    if is_str_dict(value):
        return value
    fail(command, f"{what}: ожидался JSON-объект, получено {type(value).__name__}", code=1)


def resolve_sids(selector: str, client_id: int | None, *, command: str) -> tuple[int, list[str]]:
    """Селектор → `(client_id, sids)` из локального кэша (`mpu search`)."""
    try:
        _server, candidates = resolve_server(selector)
    except ResolveError as e:
        fail(
            command,
            str(e),
            code=2,
            hint="уточни селектор или передай --client-id <id>",
            extra=format_candidates(e.candidates) if e.candidates else None,
        )
    cid = client_id if client_id is not None else auto_pick_int(candidates, "client_id")
    if cid is None:
        fail(
            command,
            f"не удалось однозначно определить client_id из {selector!r}",
            code=2,
            hint="передай --client-id <id> (или селектор клиента, не sl-N)",
            extra=format_candidates(candidates) if candidates else None,
        )
    sids: list[str] = []
    for cand in candidates:
        if cand.get("client_id") != cid:
            continue
        raw = cand.get("sids")
        if is_obj_list(raw):
            for s in raw:
                if isinstance(s, str) and s and s not in sids:
                    sids.append(s)
    return cid, sids


def sid_from_selector(selector: str, sids: list[str]) -> str | None:
    """sid, явно названный селектором: точное совпадение или однозначный substring."""
    exact = [s for s in sids if s == selector]
    if len(exact) == 1:
        return exact[0]
    substr = [s for s in sids if selector and selector in s]
    if not exact and len(substr) == 1:
        return substr[0]
    return None


def pick_sid(selector: str, sids: list[str], *, command: str) -> str:  # noqa: RET503 — fail() NoReturn, ruff не видит через импорт
    """sid из селектора > единственный > exit 2."""
    named = sid_from_selector(selector, sids)
    if named is not None:
        return named
    if len(sids) == 1:
        return sids[0]
    if not sids:
        fail(
            command,
            "не удалось определить sid клиента (кэш пуст?)",
            code=2,
            hint="укажи --sid <sid> или обнови кэш: mpu update",
        )
    fail(
        command,
        f"у клиента несколько WB sid ({len(sids)})",
        code=2,
        hint="укажи --sid <sid>",
        extra="\n".join(f"  --sid {s}" for s in sids),
    )


def resolve_target_sid(
    selector: str, sid: str | None, client_id: int | None, *, command: str
) -> tuple[str, str]:
    """→ `(sid, client_id_label)`. Прямой режим (`--sid`/UUID) — без резолва клиента."""
    direct_sid = sid if sid is not None else (selector if looks_like_sid(selector) else None)
    if direct_sid is not None:
        return direct_sid, (str(client_id) if client_id is not None else "?")
    cid, sids = resolve_sids(selector, client_id, command=command)
    return pick_sid(selector, sids, command=command), str(cid)


def cids_for_sid(sid: str) -> list[int]:
    """client_id(ы) этого sid из локального кэша — только для лейбла вывода. Никогда не падает."""
    try:
        _n, cands = resolve_server(sid)
    except ResolveError as e:
        cands = e.candidates or []
    return sorted({c for x in cands if isinstance(c := x.get("client_id"), int)})


def cid_json(cids: list[int]) -> object:
    """`client_id` для JSON: int если однозначен, список если несколько, иначе null."""
    if len(cids) == 1:
        return cids[0]
    return cids or None


def cid_label(cids: list[int]) -> str:
    """`client_id` для человекочитаемой stderr-строки."""
    return ",".join(str(c) for c in cids) if cids else "?"


def emit_curl(*, base_url: str, method: str, path: str, body: object | None = None) -> None:
    """Напечатать эквивалентный curl (+ буфер), ничего не выполняя.

    Токен НЕ кладём в команду напрямую — через `$(mpu api get-token)`, чтобы он не
    утёк в буфер/историю. `body=None` → GET-подобный вызов без `-d`.
    """
    curl = f'curl -sS -X {method} "{base_url}{path}" -H "authorization: Bearer $TOKEN"'
    if body is not None:
        body_json = json.dumps(body, ensure_ascii=False)
        curl += f" -H 'content-type: application/json' -d '{body_json}'"
    snippet = f"TOKEN=$(mpu api get-token)\n{curl}"
    click.echo(snippet)
    copy_to_clipboard(snippet)
