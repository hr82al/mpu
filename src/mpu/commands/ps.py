"""`mpu ps` — статусы Docker-контейнеров.

Без селектора — все контейнеры из локального кэша `portainer_containers`
(заполняется через `mpu init`). С селектором `sl-N` / client_id / title —
живой запрос к Portainer для конкретного сервера (STATUS-поле доступно).

По умолчанию — таблица: NAME/ENDPOINT, STATE, STATUS (только live), IMAGE.
С `--filter <substr>` режет по подстроке имени; `--json` / `--tsv` —
машинно-читаемые форматы.
"""

import json as _json
import sqlite3
from typing import Annotated

import httpx
import typer

from mpu.commands._portainer_resolve import resolve_portainer
from mpu.lib import store

COMMAND_NAME = "mpu ps"
COMMAND_SUMMARY = "Список контейнеров: без селектора — все из кэша; с sl-N — live запрос к Portainer"


app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str | None,
        typer.Argument(help="sl-N либо client_id / spreadsheet_id / title (через mpu search). "
                       "Без аргумента — все контейнеры из кэша."),
    ] = None,
    name_filter: Annotated[
        str | None,
        typer.Option("--filter", "-f", help="Подстрока имени контейнера для фильтрации"),
    ] = None,
    out_json: Annotated[
        bool,
        typer.Option("--json", help="JSON-вывод (вместо таблицы)"),
    ] = False,
    out_tsv: Annotated[
        bool,
        typer.Option("--tsv", help="TSV-вывод"),
    ] = False,
) -> None:
    """Список контейнеров.

    Без селектора — все контейнеры из локального кэша (mpu init).
    С селектором sl-N — live запрос к Portainer (включает STATUS-поле).
    """
    if selector is None:
        _all_from_cache(name_filter=name_filter, out_json=out_json, out_tsv=out_tsv)
        return

    pr = resolve_portainer(selector=selector, command_name=COMMAND_NAME)
    try:
        items = pr.client.list_containers(pr.endpoint_id)
    except httpx.HTTPError as e:
        typer.echo(f"{COMMAND_NAME}: portainer error: {e}", err=True)
        raise typer.Exit(code=1) from None

    rows = [_row(item) for item in items]
    if name_filter:
        rows = [r for r in rows if name_filter in r["name"]]
    rows.sort(key=lambda r: r["name"])

    if out_json:
        typer.echo(_json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if out_tsv:
        for r in rows:
            typer.echo(f"{r['name']}\t{r['state']}\t{r['status']}\t{r['image']}")
        return
    _print_table(rows)


def _all_from_cache(
    *,
    name_filter: str | None,
    out_json: bool,
    out_tsv: bool,
) -> None:
    """Вывести все контейнеры из SQLite-кэша portainer_containers."""
    try:
        with store.store() as conn:
            if name_filter:
                rows_raw = conn.execute(
                    "SELECT DISTINCT endpoint_name, container_name, state, image "
                    "FROM portainer_containers WHERE container_name LIKE ? "
                    "ORDER BY endpoint_name, container_name",
                    (f"%{name_filter}%",),
                ).fetchall()
            else:
                rows_raw = conn.execute(
                    "SELECT DISTINCT endpoint_name, container_name, state, image "
                    "FROM portainer_containers "
                    "ORDER BY endpoint_name, container_name",
                ).fetchall()
    except sqlite3.Error as e:
        typer.echo(f"{COMMAND_NAME}: SQLite error: {e} — запусти `mpu init`", err=True)
        raise typer.Exit(code=1) from None

    rows = [
        {
            "endpoint": r["endpoint_name"] or "?",
            "name": r["container_name"],
            "state": r["state"] or "",
            "image": r["image"] or "",
        }
        for r in rows_raw
    ]

    if not rows:
        typer.echo("(no containers in cache — запусти `mpu init`)", err=True)
        return

    typer.echo("# кэш — запусти `mpu init` для обновления", err=True)

    if out_json:
        typer.echo(_json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if out_tsv:
        for r in rows:
            typer.echo(f"{r['endpoint']}\t{r['name']}\t{r['state']}\t{r['image']}")
        return
    _print_all_table(rows)


def _print_all_table(rows: list[dict[str, str]]) -> None:
    headers = ("ENDPOINT", "NAME", "STATE", "IMAGE")
    widths = [len(h) for h in headers]
    for r in rows:
        widths[0] = max(widths[0], len(r["endpoint"]))
        widths[1] = max(widths[1], len(r["name"]))
        widths[2] = max(widths[2], len(r["state"]))
        widths[3] = max(widths[3], len(r["image"]))
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    typer.echo(fmt.format(*headers))
    for r in rows:
        typer.echo(fmt.format(r["endpoint"], r["name"], r["state"], r["image"]))


def _row(item: dict[str, object]) -> dict[str, str]:
    names_raw = item.get("Names")
    name = ""
    if isinstance(names_raw, list) and names_raw:
        first = names_raw[0]  # type: ignore[reportUnknownVariableType]
        if isinstance(first, str):
            name = first.lstrip("/")
    state = _str_field(item, "State")
    status = _str_field(item, "Status")
    image = _str_field(item, "Image")
    return {"name": name, "state": state, "status": status, "image": image}


def _str_field(item: dict[str, object], key: str) -> str:
    v = item.get(key)
    return v if isinstance(v, str) else ""


def _print_table(rows: list[dict[str, str]]) -> None:
    if not rows:
        typer.echo("(no containers)")
        return
    headers = ("NAME", "STATE", "STATUS", "IMAGE")
    widths = [len(h) for h in headers]
    for r in rows:
        widths[0] = max(widths[0], len(r["name"]))
        widths[1] = max(widths[1], len(r["state"]))
        widths[2] = max(widths[2], len(r["status"]))
        widths[3] = max(widths[3], len(r["image"]))
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    typer.echo(fmt.format(*headers))
    for r in rows:
        typer.echo(fmt.format(r["name"], r["state"], r["status"], r["image"]))
