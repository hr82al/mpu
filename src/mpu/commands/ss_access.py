"""`mpu api ss-access <verb> <spreadsheet_id>` — доступ к Google-таблице клиента (MyAccess).

Свод всех операций над доступом к таблице в одну подгруппу. Тело запроса строится
автоматически из дефолтов кнопки-ключа sl-front — `--body` писать не нужно (но можно),
остальные параметры опциональны.

Verbs:
- `request <ss>` — выдать/продлить себе (TOKEN_EMAIL) доступ. Авто-тело
  `{googleSheetsRole: editor, reason: <дефолт>, accessTemplateId: null}`; override через
  `--role/--reason/--template` или полный `--body '<json>'`.
- `status <ss>`  — показать текущие активные доступы (`GET /admin/ss/<ss>/my-access`).
- `revoke <ss>`  — отозвать доступ (job `accessGrantRevoke`). `grant_id` резолвится из main-БД
  по (ss + TOKEN_EMAIL + status в unique-индексе), либо явный `--grant-id`.
- `reset <ss>`   — revoke + дождаться выхода grant'а из индекса + request (разрулить застрявший).

`grantee` всегда = `TOKEN_EMAIL` (как у кнопки): эндпоинт выдаёт доступ владельцу токена.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, NoReturn

import click
import psycopg

from mpu.lib.pg import PgConfigError, connect_main
from mpu.lib.slapi import SlApi, SlApiError, resolve_credentials

COMMAND = "mpu api ss-access"

# Дефолт reason кнопки-ключа sl-front (ssPage.tsx: myAccessReason).
DEFAULT_REASON = "Диагностика проблемы по обращению клиента"
DEFAULT_ROLE = "editor"

# Статусы, входящие в partial unique-индекс idx_spreadsheets_access_grants_unique_active_grant
# (sl-back/src/db/appMigrations/.../create_table_spreadsheets_access_grants.sql). Именно они
# блокируют новый grant и видны как «активные» для revoke.
_INDEX_STATUSES = ("created", "permission_added", "applied")

_REVOKE_POLL_INTERVAL_S = 3.0
_REVOKE_POLL_TIMEOUT_S = 60.0


def _fail(reason: str, *, code: int, hint: str | None = None, extra: str | None = None) -> NoReturn:
    """Машинно-читаемая ошибка `<команда>: <причина>[; попробуй: <подсказка>]` → exit."""
    msg = f"{COMMAND}: {reason}"
    if hint:
        msg += f"; попробуй: {hint}"
    click.echo(msg, err=True)
    if extra:
        click.echo(extra, err=True)
    raise SystemExit(code)


def _print_json(value: object) -> None:
    click.echo(json.dumps(value, ensure_ascii=False, indent=2))


def _api() -> SlApi:
    try:
        return SlApi.from_env()
    except SlApiError as e:
        _fail(f"конфиг sl-back API: {e}", code=2)


def _token_email() -> str:
    try:
        email, _ = resolve_credentials()
    except SlApiError as e:
        _fail(f"конфиг credentials: {e}", code=2)
    return email


def _read_body(raw: str) -> Any:
    """`--body` значение: `@path` → читать файл, иначе — JSON-литерал."""
    if raw.startswith("@"):
        path = Path(raw[1:])
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as e:
            _fail(f"--body @{path}: {e}", code=2)
    else:
        content = raw
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        _fail(f"--body: невалидный JSON: {e.msg}", code=2)


def _resolve_grant_ids(spreadsheet_id: str, email: str) -> list[str]:
    """grant_id'ы в main-БД, попадающие в unique-индекс (т.е. блокирующие / активные)."""
    try:
        with connect_main() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT grant_id FROM public.spreadsheets_access_grants "
                "WHERE spreadsheet_id = %s AND grantee_email = %s "
                "AND status IN ('created', 'permission_added', 'applied')",
                (spreadsheet_id, email),
            )
            rows = cur.fetchall()
    except (PgConfigError, psycopg.Error) as e:
        _fail(f"main-БД (резолв grant_id): {e}", code=2)
    return [str(row[0]) for row in rows]


def _submit_revoke(api: SlApi, grant_id: str, reason: str) -> Any:
    """Поставить job accessGrantRevoke через POST /admin/jobs/ss."""
    body = {
        "type": "accessGrantRevoke",
        "data": {"grantId": grant_id, "revokedByUserId": None, "reason": reason},
    }
    try:
        return api.request("POST", "/admin/jobs/ss", body=body)
    except SlApiError as e:
        _fail(f"revoke job submit ({grant_id}): {e}", code=1, extra=e.body)


def _do_request(api: SlApi, spreadsheet_id: str, payload: Any) -> Any:
    try:
        return api.request("POST", f"/admin/ss/{spreadsheet_id}/my-access/request", body=payload)
    except SlApiError as e:
        _fail(f"request: {e}", code=1, extra=e.body)


def _request_payload(role: str, reason: str, template: str | None, body: str | None) -> Any:
    """Полный override через --body, иначе авто-тело из дефолтов кнопки."""
    if body is not None:
        return _read_body(body)
    return {"googleSheetsRole": role, "reason": reason, "accessTemplateId": template}


# ──────────────────────────────────────────────────────────────────────────────
# Verb-команды
# ──────────────────────────────────────────────────────────────────────────────


def _status_cmd() -> click.Command:
    def callback(spreadsheet_id: str) -> None:
        api = _api()
        try:
            resp = api.request("GET", f"/admin/ss/{spreadsheet_id}/my-access")
        except SlApiError as e:
            _fail(f"status: {e}", code=1, extra=e.body)
        _print_json(resp)

    return click.Command(
        name="status",
        params=[click.Argument(["spreadsheet_id"], required=True, type=str)],
        callback=callback,
        help="GET /admin/ss/<ss>/my-access — текущие активные доступы.",
        context_settings={"help_option_names": ["-h", "--help"]},
    )


def _request_cmd() -> click.Command:
    def callback(
        spreadsheet_id: str, reason: str, role: str, template: str | None, body: str | None
    ) -> None:
        api = _api()
        payload = _request_payload(role=role, reason=reason, template=template, body=body)
        _print_json(_do_request(api, spreadsheet_id, payload))

    return click.Command(
        name="request",
        params=[
            click.Argument(["spreadsheet_id"], required=True, type=str),
            click.Option(
                ["--reason"], default=DEFAULT_REASON, type=str, help="Обоснование (3..500)."
            ),
            click.Option(
                ["--role"], default=DEFAULT_ROLE, type=str, help="googleSheetsRole (только editor)."
            ),
            click.Option(
                ["--template"], default=None, type=str, help="accessTemplateId (UUID) или пусто."
            ),
            click.Option(
                ["--body", "-b"],
                default=None,
                type=str,
                help="Полный JSON body (override) или @file.",
            ),
        ],
        callback=callback,
        help="POST /admin/ss/<ss>/my-access/request — выдать/продлить себе доступ (как кнопка).",
        context_settings={"help_option_names": ["-h", "--help"]},
    )


def _revoke_cmd() -> click.Command:
    def callback(spreadsheet_id: str, grant_id: str | None, reason: str) -> None:
        email = _token_email()
        grant_ids = [grant_id] if grant_id else _resolve_grant_ids(spreadsheet_id, email)
        if not grant_ids:
            click.echo(
                f"{COMMAND} revoke: активных grant'ов для {email} на {spreadsheet_id} "
                f"не найдено (status in {_INDEX_STATUSES}). Нечего отзывать."
            )
            return
        api = _api()
        results = [
            {"grantId": gid, "submit": _submit_revoke(api, gid, reason)} for gid in grant_ids
        ]
        _print_json(results)

    return click.Command(
        name="revoke",
        params=[
            click.Argument(["spreadsheet_id"], required=True, type=str),
            click.Option(
                ["--grant-id"],
                default=None,
                type=str,
                help="Явный grant_id (иначе резолв из main-БД).",
            ),
            click.Option(["--reason"], default="revoke via mpu", type=str, help="Причина отзыва."),
        ],
        callback=callback,
        help="Отозвать доступ (job accessGrantRevoke). grant_id резолвится по ss + TOKEN_EMAIL.",
        context_settings={"help_option_names": ["-h", "--help"]},
    )


def _reset_cmd() -> click.Command:
    def callback(spreadsheet_id: str, reason: str, role: str, template: str | None) -> None:
        email = _token_email()
        api = _api()

        grant_ids = _resolve_grant_ids(spreadsheet_id, email)
        for gid in grant_ids:
            _submit_revoke(api, gid, "reset via mpu")
        if grant_ids:
            click.echo(
                f"{COMMAND} reset: отозвано {len(grant_ids)} grant(ов), ждём выхода из индекса…",
                err=True,
            )

        deadline = time.monotonic() + _REVOKE_POLL_TIMEOUT_S
        while _resolve_grant_ids(spreadsheet_id, email):
            if time.monotonic() > deadline:
                _fail(
                    f"revoke не отработал за {int(_REVOKE_POLL_TIMEOUT_S)}с — grant в индексе",
                    code=1,
                    hint="revoke pipeline, вероятно, сломан; ручной DB-expire застрявшей строки",
                )
            time.sleep(_REVOKE_POLL_INTERVAL_S)

        payload = _request_payload(role=role, reason=reason, template=template, body=None)
        _print_json(_do_request(api, spreadsheet_id, payload))

    return click.Command(
        name="reset",
        params=[
            click.Argument(["spreadsheet_id"], required=True, type=str),
            click.Option(
                ["--reason"],
                default=DEFAULT_REASON,
                type=str,
                help="Обоснование для финального request.",
            ),
            click.Option(
                ["--role"], default=DEFAULT_ROLE, type=str, help="googleSheetsRole (только editor)."
            ),
            click.Option(
                ["--template"], default=None, type=str, help="accessTemplateId (UUID) или пусто."
            ),
        ],
        callback=callback,
        help="revoke застрявший grant → дождаться → request заново (разрулить блок).",
        context_settings={"help_option_names": ["-h", "--help"]},
    )


def build_command() -> click.Group:
    """click.Group `ss-access` для монтирования в `mpu api` (build_api_group)."""
    group = click.Group(
        name="ss-access",
        help=__doc__,
        context_settings={"help_option_names": ["-h", "--help"]},
    )
    group.add_command(_request_cmd())
    group.add_command(_status_cmd())
    group.add_command(_revoke_cmd())
    group.add_command(_reset_cmd())
    return group
