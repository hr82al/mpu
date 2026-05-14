"""`mpu p health` — быстрый health-check sl-N: статусы контейнеров + tail логов loader'ов.

Использование:
    mpu p health <selector> [--tail N] [--since 30m] [--all]

`<selector>` — `sl-N` либо client_id / spreadsheet_id / title (через `mpu search`).

Что делает:
1. `docker ps` через Portainer → таблица всех `mp-*` контейнеров.
2. One-shot контейнеры (migrations и т.п., см. `_ONE_SHOT_KEYWORDS`) с `Exited (0)`
   считаются OK — это батч-job'ы, не daemon'ы; идут в отдельный блок «init OK», не
   в ⚠️ и не влияют на exit-code.
3. Остальные не-running контейнеры идут в блок `⚠️ Containers not in 'running' state`.
4. Для каждого loader-контейнера (имя содержит `loader` / `processor` / `updater` /
   `nats-listeners` / `workers` / `instance-app` / `main-app`) — печатает последние
   `--tail` строк stderr. С `--all` — для всех `mp-*` контейнеров.
5. Возвращает exit-code 1 если есть хотя бы один НЕОЖИДАЕМО не-running контейнер
   (то есть не из one-shot набора); иначе 0.

Дальше использовать `mpup-logs <selector> <container>` для углублённого разбора
конкретного контейнера и `mpu p ssh <selector> -- <cmd>` для exec-проверок
(Redis / NATS / токены — TODO следующей итерацией: набор `node cli service:...`
команд для BullMQ-stats / NATS-consumer-info / wb_tokens-freshness).
"""

import sys
from typing import Annotated

import httpx
import typer

from mpu.commands._portainer_resolve import PortainerResolved, resolve_portainer

COMMAND_NAME = "mpu p health"
COMMAND_SUMMARY = "Health-check sl-N: статусы контейнеров + tail логов loader'ов"


_LOADER_KEYWORDS = (
    "loader",
    "data-processor",
    "ss-updater",
    "ss-loader",
    "ss-jobs",
    "nats-listeners",
    "workers",
    "instance-app",
    "main-app",
)

# Контейнеры-«init job'ы»: запускаются один раз, делают свою работу и Exit(0).
# Для них Exited (0) — норма (всё применилось), Exited (≠0) — реальная проблема.
# Совпадение по подстроке имени, не строгое: `mp-sl-14-migrations`,
# `mp-sl-14-i-clients-migrations`, `mp-wb-instance-migrations`, `mp-wb-sids-migrations`,
# `mp-wb-instance-instance-migrations` и т.п. — всех ловит «migrations» / «-migrations-».
_ONE_SHOT_KEYWORDS = (
    "migrations",
    "init-",
)


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
    tail: Annotated[
        int,
        typer.Option("--tail", "-n", help="Сколько строк лога печатать на каждый контейнер"),
    ] = 30,
    since: Annotated[
        str | None,
        typer.Option(
            "--since",
            help="Период для логов: 30m / 1h / 2d / unix-ts (как в `mpup-logs --since`)",
        ),
    ] = None,
    all_logs: Annotated[
        bool,
        typer.Option(
            "--all",
            help="Печатать tail для всех `mp-*` контейнеров, не только loader'ов",
        ),
    ] = False,
) -> None:
    """Health-check: статусы контейнеров + tail логов потенциальных виновников."""
    pr = resolve_portainer(selector=selector, command_name=COMMAND_NAME)
    try:
        items = pr.client.list_containers(pr.endpoint_id)
    except httpx.HTTPError as e:
        typer.echo(f"{COMMAND_NAME}: portainer error: {e}", err=True)
        raise typer.Exit(code=1) from None

    rows = [_row(it) for it in items]
    rows = [r for r in rows if r["name"]]
    rows.sort(key=lambda r: r["name"])

    mp_rows = [r for r in rows if r["name"].startswith(("mp-sl-", "mp-wb-"))]

    typer.echo(f"=== sl-{pr.server_number}: {len(mp_rows)} mp-* containers ===\n")
    _print_table(mp_rows or rows)

    not_running = [r for r in mp_rows if r["state"] != "running"]
    one_shot_ok = [r for r in not_running if _is_one_shot_completed(r)]
    bad = [r for r in not_running if not _is_one_shot_completed(r)]

    if one_shot_ok:
        typer.echo("\n✓ One-shot containers (completed normally):")
        for r in one_shot_ok:
            typer.echo(f"  {r['name']}: {r['status']}")

    if bad:
        typer.echo("\n⚠️  Containers not in 'running' state:")
        for r in bad:
            typer.echo(f"  {r['name']}: state={r['state']} status={r['status']}")

    # Daemons: исключаем one-shot, чтобы не флудить логами завершённых init-job'ов.
    daemons = [r for r in mp_rows if not _matches(r["name"], _ONE_SHOT_KEYWORDS)]
    targets = daemons if all_logs else [r for r in daemons if _is_loader(r["name"])]
    if targets:
        typer.echo(f"\n=== tail --{tail} (stderr) for {len(targets)} container(s) ===")
        _tail_logs(pr, [r["name"] for r in targets], tail=tail, since=since)

    if bad:
        raise typer.Exit(code=1)


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


def _is_loader(name: str) -> bool:
    return _matches(name, _LOADER_KEYWORDS)


def _matches(name: str, keywords: tuple[str, ...]) -> bool:
    n = name.lower()
    return any(kw in n for kw in keywords)


def _is_one_shot_completed(row: dict[str, str]) -> bool:
    """One-shot job, который штатно завершился: имя из `_ONE_SHOT_KEYWORDS` + `Exited (0) ...`."""
    if not _matches(row["name"], _ONE_SHOT_KEYWORDS):
        return False
    return row["state"] == "exited" and row["status"].startswith("Exited (0)")


def _print_table(rows: list[dict[str, str]]) -> None:
    headers = ("NAME", "STATE", "STATUS")
    widths = [len(h) for h in headers]
    for r in rows:
        widths[0] = max(widths[0], len(r["name"]))
        widths[1] = max(widths[1], len(r["state"]))
        widths[2] = max(widths[2], len(r["status"]))
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    typer.echo(fmt.format(*headers))
    for r in rows:
        typer.echo(fmt.format(r["name"], r["state"], r["status"]))


def _tail_logs(pr: PortainerResolved, names: list[str], *, tail: int, since: str | None) -> None:
    from mpu.lib.duration import DurationParseError, parse_since

    try:
        since_ts = parse_since(since) if since else None
    except DurationParseError as e:
        typer.echo(f"{COMMAND_NAME}: --since: {e}", err=True)
        raise typer.Exit(code=2) from None
    for name in names:
        typer.echo(f"\n--- {name} (stderr, tail={tail}) ---")
        try:
            _, err = pr.client.container_logs(
                name,
                tail=tail,
                since=since_ts,
                stdout=False,
                stderr=True,
                timestamps=True,
            )
        except httpx.HTTPError as e:
            typer.echo(f"  (logs error: {e})")
            continue
        if not err:
            typer.echo("  (no stderr in window)")
            continue
        sys.stdout.buffer.write(err)
        sys.stdout.buffer.flush()
