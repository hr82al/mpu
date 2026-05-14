"""`mpu p ps` — статусы Docker-контейнеров на sl-N через Portainer.

Селектор первый аргумент — как у `mpu search`: `sl-N` либо client_id /
spreadsheet_id substring / title substring (резолв через `lib.resolver`).

По умолчанию — таблица: NAME, STATE, STATUS, IMAGE. С `--filter <substr>` режет
по подстроке имени; `--json` / `--tsv` — машинно-читаемые форматы.
"""

import json as _json
from typing import Annotated

import httpx
import typer

from mpu.commands._portainer_resolve import resolve_portainer

COMMAND_NAME = "mpu p ps"
COMMAND_SUMMARY = "Список контейнеров на sl-N через Portainer (статусы)"


app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    selector: Annotated[
        str,
        typer.Argument(help="sl-N либо client_id / spreadsheet_id / title (через mpu search)"),
    ],
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
        typer.Option("--tsv", help="TSV-вывод (NAME\\tSTATE\\tSTATUS\\tIMAGE)"),
    ] = False,
) -> None:
    """Получить список контейнеров (`docker ps -a`) сервера sl-N через Portainer."""
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
