"""`mpu api wb-loader-config <selector> <loader>` — per-sid параметры wb-loader-app загрузчика.

Без флагов — read-only `GET /admin/wb-loader/loaders/<sid>/<loader>/v1/config`:
`effective` (base ⊕ per-sid), `base` (пришедший с wb-main), `perSid` (сырая дельта
этого кабинета) и `fields` (что вообще редактируется per-sid).

Мутации (`wbLoaderWriteGate`, роль `support_write`+) — это и есть запуск/остановка
конкретного загрузчика на конкретном кабинете:

- `--enable` — `POST .../v1/config {"enabled": true}`: контроллер инстанса на
  ближайшей реконсиляции (≤60 с) заводит job, загрузчик начинает свой цикл.
- `--disable` — то же с `false`: processor на следующем тике выходит и job больше
  не переоткладывается («loader disabled — sleeping»). Курсор/данные не трогаются.
- `--reset` — `POST .../v1/config/reset`: снять per-sid дельту целиком, вернуть
  кабинет к базовой конфигурации (для загрузчиков с `enabled: false` в дефолте это
  и есть «как было до включения»).

Тело POST — **частичная дельта**, а не полная замена: `--enable`/`--disable` шлют
ровно `{"enabled": …}` и остальные per-sid поля не затирают.

- `<loader>` — kebab-слаг (`adv-upd`, `cards`, …; автодополнение).
- Селектор / `--sid` / `--client-id` / `--print` — как у `wb-loader-status`.
- Форс-прогон без ожидания цикла — `wb-loader-load`; состояние — `wb-loader-status`.
"""

from __future__ import annotations

import click

from mpu.commands._wb_loader import (
    LOADER_ENTITIES,
    LOADER_REFERENCE_HELP,
    complete_entity,
    emit_curl,
    fail,
    loader_path,
    print_json,
    resolve_target_sid,
    wrong_form_hint,
)
from mpu.lib.slapi import HttpMethod, SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-loader-config"

_FORBIDDEN_STATUS = 403


def _pick_action(
    *, enable: bool, disable: bool, reset: bool
) -> tuple[HttpMethod, str, object | None]:
    """Флаги → `(method, action, body)`. Ровно один мутирующий флаг, иначе exit 2."""
    chosen = [
        name
        for name, on in (("--enable", enable), ("--disable", disable), ("--reset", reset))
        if on
    ]
    if len(chosen) > 1:
        fail(COMMAND, f"взаимоисключающие флаги: {', '.join(chosen)}", code=2, hint="оставь один")
    if reset:
        return "POST", "config/reset", None
    if enable or disable:
        return "POST", "config", {"enabled": enable}
    return "GET", "config", None


def _request(*, method: HttpMethod, path: str, body: object | None) -> object:
    """Вызов sl-back с человекочитаемой диагностикой 403 (не хватает роли)."""
    try:
        api = SlApi.from_env()
    except SlApiError as e:
        fail(COMMAND, str(e), code=1)
    try:
        return api.request(method, path, body=body)
    except SlApiError as e:
        if e.status == _FORBIDDEN_STATUS:
            fail(
                COMMAND,
                "config запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        fail(COMMAND, f"config не удался: {e}", code=1, extra=e.body)


def _run(
    *,
    selector: str,
    loader: str,
    sid: str | None,
    client_id: int | None,
    enable: bool,
    disable: bool,
    reset: bool,
    print_mode: bool,
) -> None:
    if loader not in LOADER_ENTITIES:
        fail(
            COMMAND,
            f"неизвестный loader {loader!r}",
            code=2,
            hint=wrong_form_hint(loader) or f"один из: {', '.join(LOADER_ENTITIES)}",
        )
    method, action, body = _pick_action(enable=enable, disable=disable, reset=reset)
    target_sid, cid_human = resolve_target_sid(selector, sid, client_id, command=COMMAND)
    path = loader_path(target_sid, loader, action)

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            fail(COMMAND, str(e), code=1)
        emit_curl(base_url=base_url, method=method, path=path, body=body)
        return

    raw = _request(method=method, path=path, body=body)
    click.echo(
        f"# client {cid_human} sid {target_sid} loader {loader}: {method} {action}", err=True
    )
    print_json({"client_id": cid_human, "sid": target_sid, "loader": loader, "config": raw})


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    params: list[click.Parameter] = [
        click.Argument(["selector"], required=True, type=str),
        click.Argument(["loader"], required=True, type=str, shell_complete=complete_entity),
        click.Option(
            ["--sid"],
            default=None,
            type=str,
            help="Явный WB sid: прямой режим, без резолва клиента",
        ),
        click.Option(
            ["--client-id", "client_id"],
            default=None,
            type=int,
            help="Явный client_id при неоднозначном селекторе",
        ),
        click.Option(
            ["--enable", "enable"],
            is_flag=True,
            default=False,
            help="Включить загрузчик на этом кабинете (POST config {enabled: true})",
        ),
        click.Option(
            ["--disable", "disable"],
            is_flag=True,
            default=False,
            help="Выключить загрузчик на этом кабинете (POST config {enabled: false})",
        ),
        click.Option(
            ["--reset", "reset"],
            is_flag=True,
            default=False,
            help="Снять per-sid дельту целиком (POST config/reset) — вернуть базовую конфигурацию",
        ),
        click.Option(
            ["--print", "-p", "print_mode"],
            is_flag=True,
            default=False,
            help="Напечатать эквивалентный curl (+ буфер), без выполнения",
        ),
    ]

    return click.Command(
        name="wb-loader-config",
        params=params,
        callback=_run,
        help=(__doc__ or "") + LOADER_REFERENCE_HELP,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
