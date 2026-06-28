"""`mpu clean-local-clients` — снести данные локальных клиентов кроме keep-листа.

Удаляет per-client данные ВСЕХ локальных клиентов (схемы `schema_<id>` на sl-1) КРОМЕ
keep-листа (по умолчанию `54,776`) и `shared`-схемы. Чистит sl-1 + sl-0 + sw-back
(`mp-sl-1-pg` / `mp-sl-0-pg` / `mp-sw-pg`) — только локальные контейнеры, никогда не прод.

По умолчанию — **сухой прогон** (только показывает, что удалит). Реальное удаление —
с флагом `--yes`. Деструктивно: `DROP SCHEMA ... CASCADE` + удаление строк.
"""

from __future__ import annotations

from typing import Annotated

import typer

from mpu.lib import local_clean, pg
from mpu.lib.pg import PgConfigError

COMMAND_NAME = "mpu clean-local-clients"
COMMAND_SUMMARY = (
    "Удалить локальные данные всех клиентов кроме keep-листа (default 54,776) и shared"
)

DEFAULT_KEEP = "54,776"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def parse_keep(raw: str) -> set[int]:
    """`"54, 776"` → `{54, 776}`. Пустые/нечисловые токены → ошибка."""
    ids: set[int] = set()
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        if not token.isdigit():
            raise typer.BadParameter(f"keep: {token!r} не число (ожидается список client_id)")
        ids.add(int(token))
    return ids


@app.command()
def main(
    keep: Annotated[
        str,
        typer.Option("--keep", help="client_id оставить (через запятую)"),
    ] = DEFAULT_KEEP,
    yes: Annotated[
        bool,
        typer.Option("--yes", help="реально удалить (без флага — сухой прогон)"),
    ] = False,
) -> None:
    """Снести локальные данные клиентов кроме keep-листа (`--yes` — выполнить, иначе dry-run)."""
    keep_ids = parse_keep(keep)
    try:
        sl = pg.local_sl_conn()
        main_dst = pg.local_main_conn()
        ws = pg.local_workspaces_conn()
    except PgConfigError as e:
        typer.echo(f"{COMMAND_NAME}: {e}", err=True)
        raise typer.Exit(code=2) from None

    all_ids = local_clean.local_client_ids(sl)
    targets = [i for i in all_ids if i not in keep_ids]

    typer.echo(f"локальные клиенты sl-1: {all_ids or '—'}")
    typer.echo(f"оставляю (keep): {sorted(keep_ids)} + схема shared")
    if not targets:
        typer.echo("✓ нечего удалять — все локальные клиенты в keep-листе")
        return
    typer.echo(f"под удаление: {targets}")

    if not yes:
        typer.echo("")
        typer.echo("сухой прогон — ничего не удалено. Для удаления повтори с --yes")
        return

    removed = local_clean.clean_clients(sl, main_dst, ws, targets)
    typer.echo("")
    typer.echo(
        f"✓ удалено {len(targets)} клиент(ов) из sl-1 (схемы + public) + sl-0 (токены); "
        f"sw-back: снято {removed} workspace-проводок"
    )
