"""`mpu api wb-loader-reset <selector> <loader>` — сброс state + перезапуск загрузчика.

`POST /admin/wb-loader/loaders/<sid>/<loader>/v1/reset` (sl-back main →
wb-loader-app): `facade.resetState` + `resetJob` — чистит progress; ближайший
прогон пересчитывает окно. Без опций — reset с пустым телом (forward-only пойдёт
с `today - history_days`).

Окно дозагрузки (взаимоисключающие):
- `--state '<json>'` — partial-state как есть (любой загрузчик), напр.
  `{"cursor":null}` (cursor-based) или `{"lastLoadedDate":"2026-06-08"}`.
- `--from <YYYY-MM-DD>` — для **forward-only** загрузчиков (state с `lastLoadedDate`):
  собирает `{"lastLoadedDate": <from-1день>}`, чтобы ближайший прогон пошёл с <from>.
  ⚠️ forward-only: верхняя граница окна всегда «вчера» — участок точно не задаётся,
  свежие дни перезальются (идемпотентно).

`--and-load` — следом дёрнуть `load` (форс-прогон): типовой recovery в один вызов.

Мутирует прод (`wbLoaderWriteGate`, роль `support_write`+). Read-only аналог —
`wb-loader-status`. Селектор / `--sid` / `--client-id` / `--print` — как у него.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import click

from mpu.commands._wb_loader import (
    FORWARD_ONLY_ENTITIES,
    LOADER_ENTITIES,
    complete_entity,
    emit_curl,
    fail,
    is_str_dict,
    loader_path,
    print_json,
    resolve_target_sid,
)
from mpu.lib.slapi import SlApi, SlApiError, resolve_base_url

COMMAND = "mpu api wb-loader-reset"


def _build_state(
    loader: str, state_json: str | None, from_date: str | None
) -> dict[str, object] | None:
    """`--state` / `--from` → partial-state для тела reset (или None — пустой reset)."""
    if state_json is not None and from_date is not None:
        fail(COMMAND, "--state и --from взаимоисключающи", code=2, hint="оставь что-то одно")
    if state_json is not None:
        try:
            parsed: object = json.loads(state_json)
        except json.JSONDecodeError as e:
            fail(COMMAND, f"--state: невалидный JSON: {e.msg}", code=2)
        if not is_str_dict(parsed):
            fail(COMMAND, "--state: ожидается JSON-объект", code=2)
        return parsed
    if from_date is not None:
        if loader not in FORWARD_ONLY_ENTITIES:
            fail(
                COMMAND,
                f"--from неприменим к loader {loader!r} (не forward-only)",
                code=2,
                hint="--from только для forward-only загрузчиков; иначе используй --state",
            )
        try:
            parsed_date = date.fromisoformat(from_date)
        except ValueError:
            fail(COMMAND, f"--from: ожидается дата YYYY-MM-DD, получено {from_date!r}", code=2)
        return {"lastLoadedDate": (parsed_date - timedelta(days=1)).isoformat()}
    return None


def _run(
    *,
    selector: str,
    loader: str,
    sid: str | None,
    client_id: int | None,
    state_json: str | None,
    from_date: str | None,
    and_load: bool,
    print_mode: bool,
) -> None:
    if loader not in LOADER_ENTITIES:
        fail(
            COMMAND,
            f"неизвестный loader {loader!r}",
            code=2,
            hint=f"один из: {', '.join(LOADER_ENTITIES)}",
        )
    state = _build_state(loader, state_json, from_date)
    body: dict[str, object] | None = {"state": state} if state is not None else None
    target_sid, cid_human = resolve_target_sid(selector, sid, client_id, command=COMMAND)
    reset_path = loader_path(target_sid, loader, "reset")
    load_path = loader_path(target_sid, loader, "load")

    if print_mode:
        try:
            base_url = resolve_base_url()
        except SlApiError as e:
            fail(COMMAND, str(e), code=1)
        emit_curl(base_url=base_url, method="POST", path=reset_path, body=body)
        if and_load:
            emit_curl(base_url=base_url, method="POST", path=load_path)
        return

    try:
        api = SlApi.from_env()
    except SlApiError as e:
        fail(COMMAND, str(e), code=1)

    result: dict[str, object] = {"client_id": cid_human, "sid": target_sid, "loader": loader}
    try:
        result["reset"] = api.request("POST", reset_path, body=body)
    except SlApiError as e:
        if e.status == 403:
            fail(
                COMMAND,
                "reset запрещён (HTTP 403)",
                code=1,
                hint="у TOKEN_EMAIL должна быть роль support_write или выше",
                extra=e.body,
            )
        fail(COMMAND, f"reset не удался: {e}", code=1, extra=e.body)
    if and_load:
        try:
            result["load"] = api.request("POST", load_path)
        except SlApiError as e:
            fail(COMMAND, f"load не удался (reset выполнен): {e}", code=1, extra=e.body)
    action = "reset + load" if and_load else "reset"
    click.echo(f"# client {cid_human} sid {target_sid} loader {loader}: {action}", err=True)
    print_json(result)


def build_command() -> click.Command:
    """Собрать `click.Command` для монтажа в `mpu api`-группу."""

    def callback(
        selector: str,
        loader: str,
        sid: str | None,
        client_id: int | None,
        state_json: str | None,
        from_date: str | None,
        and_load: bool,
        print_mode: bool,
    ) -> None:
        _run(
            selector=selector,
            loader=loader,
            sid=sid,
            client_id=client_id,
            state_json=state_json,
            from_date=from_date,
            and_load=and_load,
            print_mode=print_mode,
        )

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
            ["--state", "state_json"],
            default=None,
            type=str,
            help='Partial-state JSON для reset, напр. \'{"lastLoadedDate":"2026-06-08"}\'',
        ),
        click.Option(
            ["--from", "from_date"],
            default=None,
            type=str,
            help="YYYY-MM-DD (forward-only loader): собрать lastLoadedDate=from-1день",
        ),
        click.Option(
            ["--and-load", "and_load"],
            is_flag=True,
            default=False,
            help="Следом дёрнуть load (форс-прогон)",
        ),
        click.Option(
            ["--print", "-p", "print_mode"],
            is_flag=True,
            default=False,
            help="Напечатать эквивалентный curl (+ буфер), без выполнения",
        ),
    ]

    return click.Command(
        name="wb-loader-reset",
        params=params,
        callback=callback,
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
