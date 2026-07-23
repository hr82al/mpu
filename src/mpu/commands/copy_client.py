"""`mpu copy-client <selector>` — скопировать клиента с прод-PG в локальный dev-PG (`sl-1`).

Нативный Python (`pg_dump`/`pg_restore` + psycopg COPY), без dt-host/clientsTransfer:

- схема `schema_<id>` снимается с прод-инстанса и **восстанавливается** в локальный sl-1
  (`DROP SCHEMA ... CASCADE` + `pg_restore --no-owner --no-privileges`) — схема создаётся
  сама, если её не было (паритет с `mpu make-schema`; отдельный ручной шаг больше не нужен),
  а `--no-*` снимает зависимость от ролей `client_<id>`/`support_*` на target;
- public-строки клиента (loader_info, spreadsheets, …) → sl-1, токен-строки → sl-0 main;
- весь процесс (дамп/восстановление схемы + построчные счётчики таблиц) виден в выводе.

Источник резолвится из селектора (`mpu search`-семантика: client_id / spreadsheet_id
substring / title substring / sl-N), цель — всегда локальный sl-1 (`mp-sl-1-pg`, порт 5441)
+ sl-0 (`mp-sl-0-pg`, порт 5440). Прод читается read-only (pg_dump + SELECT), пишется
только в локальные контейнеры — единственный санкционированный мост прод→локаль.
"""

from __future__ import annotations

from typing import Annotated

import typer

from mpu.lib import pg, pg_copy, sw_seed
from mpu.lib.pg import PgConfigError
from mpu.lib.resolver import require_single_client_id, resolve_server_or_exit

COMMAND_NAME = "mpu copy-client"
COMMAND_SUMMARY = "Скопировать клиента с прод-PG в локальный dev-PG (нативный pg_dump + COPY)"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(
            help="client_id / spreadsheet_id substring / title substring / sl-N "
            "(должен резолвиться в одного клиента)"
        ),
    ],
) -> None:
    """Скопировать клиента с прод-PG в локальный dev-PG (`sl-1`), нативно (`pg_dump`/COPY)."""
    server_number, candidates = resolve_server_or_exit(selector, command_name=COMMAND_NAME)

    client_id = require_single_client_id(
        candidates, selector=selector, server_number=server_number, command_name=COMMAND_NAME
    )

    try:
        src = pg.instance_conn(server_number)
        dst = pg.local_sl_conn()
        main_dst = pg.local_main_conn()
    except PgConfigError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        raise typer.Exit(code=2) from None

    schema = f"schema_{client_id}"
    src_label = f"sl-{server_number}"
    typer.echo(
        f"→ copy-client {client_id}: {src_label} (прод, read-only) → локальный sl-1", err=True
    )

    state = (
        "есть — пересоздаю из источника"
        if pg_copy.schema_exists(dst, schema)
        else "нет — будет создана из источника"
    )
    typer.echo(f"… {schema} в локальном sl-1: {state}", err=True)

    pg_copy.dump_restore_schema(src, dst, schema, src_label=src_label)
    pg_copy.grant_client_role(dst, client_id)
    pg_copy.copy_public_rows(src, dst, client_id)
    pg_copy.copy_main_rows(src, main_dst, client_id)
    # main internal-api резолвит клиента через Redis clients-кэш (без PG-fallback) — засеять,
    # иначе web-data ручки отвечают «client not found» даже при наличии строки в public.clients.
    pg_copy.seed_main_clients_cache(main_dst, client_id)

    # пост-действие: вход в локальный sw-front под этим клиентом (idempotent).
    # Не фейлит копию: схема+данные уже на месте, проводку sw-back можно догнать повтором.
    login = None
    try:
        typer.echo(f"… sw-front: завожу вход для workspace {client_id}", err=True)
        cabinets = sw_seed.read_client_cabinets(dst, client_id)
        login = sw_seed.seed_login_workspace(pg.local_workspaces_conn(), client_id, cabinets)
        sw_seed.flush_sw_redis()
    except Exception as e:  # best-effort: схема+данные уже в sl-1, проводку догонит повтор
        typer.echo(
            f"{COMMAND_NAME}: WARN проводка sw-front не удалась ({e}); копия в sl-1 готова",
            err=True,
        )

    typer.echo(f"✓ client {client_id}: схема + public-строки → sl-1, токен-строки → sl-0.")
    if login:
        typer.echo(f"✓ вход: http://sw.localhost/login → {login} / {sw_seed.LOGIN_PASSWORD}")
        typer.echo(
            f"  (workspace {client_id}; если раздел просит активировать подписку — добавь "
            f"{client_id} в BILLING_MOCK_ACCESS_WORKSPACE_IDS фронта и пересоздай sw-front)"
        )
