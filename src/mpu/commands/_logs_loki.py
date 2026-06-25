"""Loki-backend для `mpu logs` — `query_range` против `LOKI_URL` без auth.

Маппинг labels стенда (см. вывод `/loki/api/v1/labels`):
    host             — sl-0..sl-14, wb-0..wb-3, dt-1, wb-clusters, wb-positions
    compose_service  — api, data-loader, wb-loader, internal-api, ...
    compose_project  — mp-sl-N, mp-wb-N, mp-front, ...
    level            — parsed log level (info, error, warn, ...)
    stream           — stdout / stderr

Selector → host:
    1. sl-N / wb-N / dt-N / wb-(clusters|positions)  →  host=<value>
    2. иначе — резолв через resolver.resolve_server (client_id / spreadsheet / title) → host=sl-N

Кэш hosts/services для autocompletion и `ls` — таблицы `loki_hosts` /
`loki_services_by_host` в `~/.config/mpu/mpu.db`. Заполняются `mpu init` и
`mpu update` через `lib/loki_discover.py`.
"""

import re
import sqlite3
import sys
import time

import httpx
import typer

from mpu.lib import loki, servers, store
from mpu.lib.duration import DurationParseError, parse_since
from mpu.lib.resolver import ResolveError, format_candidates, resolve_server

_DIRECT_HOST_RE = re.compile(r"\A(sl-\d+|wb-\d+|dt-\d+|wb-clusters|wb-positions)\Z")
_DEFAULT_SINCE_SECONDS = 5 * 60
_FOLLOW_POLL_INTERVAL = 2.0
_FOLLOW_INITIAL_SECONDS = 10


def run(
    *,
    command_name: str,
    selector: str | None,
    service: str | None,
    tail: int,
    since: str | None,
    timestamps: bool,
    no_stdout: bool,
    no_stderr: bool,
    grep: list[str],
    grep_regex: list[str],
    level: str | None,
    client_id: int | None,
) -> None:
    """Query Loki для tail-семантики и печать в хронологическом порядке."""
    base_url = servers.env_value("LOKI_URL")
    if not base_url:
        typer.echo(f"{command_name}: LOKI_URL не задан в ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)

    host = _selector_to_host(selector, command_name=command_name) if selector is not None else None
    start_ns, end_ns = _time_range(since, command_name=command_name)
    logql = _build_logql(
        host=host,
        service=service,
        level=level,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep,
        grep_regex=grep_regex,
        client_id=client_id,
    )

    try:
        entries = loki.query_range(
            base_url=base_url,
            logql=logql,
            start_ns=start_ns,
            end_ns=end_ns,
            limit=tail,
        )
    except httpx.HTTPStatusError as e:
        body = e.response.text.strip()[:500]
        typer.echo(f"{command_name}: loki HTTP {e.response.status_code}: {body}", err=True)
        typer.echo(f"  query: {logql}", err=True)
        raise typer.Exit(code=1) from None
    except httpx.HTTPError as e:
        typer.echo(f"{command_name}: loki error: {e}", err=True)
        raise typer.Exit(code=1) from None

    entries.sort(key=lambda e: e.ts_ns)
    for entry in entries:
        _print_entry(entry, timestamps=timestamps)
    sys.stdout.flush()


def _print_entry(entry: loki.LogEntry, *, timestamps: bool) -> None:
    line = entry.line.rstrip("\n")
    if timestamps:
        sys.stdout.write(f"{_format_ts(entry.ts_ns)} {line}\n")
    else:
        sys.stdout.write(f"{line}\n")


def follow(
    *,
    command_name: str,
    selector: str | None,
    service: str | None,
    since: str | None,
    timestamps: bool,
    no_stdout: bool,
    no_stderr: bool,
    grep: list[str],
    grep_regex: list[str],
    level: str | None,
    client_id: int | None,
) -> None:
    """Следить за новыми логами в реальном времени (аналог `tail -f`).

    Начинает с `--since` (или последних 10 сек), затем каждые 2 сек опрашивает
    Loki за новые записи. Выход — Ctrl+C.
    """
    base_url = servers.env_value("LOKI_URL")
    if not base_url:
        typer.echo(f"{command_name}: LOKI_URL не задан в ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)

    host = _selector_to_host(selector, command_name=command_name) if selector is not None else None
    logql = _build_logql(
        host=host,
        service=service,
        level=level,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep,
        grep_regex=grep_regex,
        client_id=client_id,
    )

    now_s = int(time.time())
    if since is not None:
        try:
            start_s = parse_since(since)
        except DurationParseError as e:
            typer.echo(f"{command_name}: --since: {e}", err=True)
            raise typer.Exit(code=2) from None
    else:
        start_s = now_s - _FOLLOW_INITIAL_SECONDS

    last_ts_ns = start_s * 1_000_000_000

    # Начальная порция: показать историю за [since, now]
    try:
        initial = loki.query_range(
            base_url=base_url,
            logql=logql,
            start_ns=last_ts_ns,
            end_ns=now_s * 1_000_000_000,
            limit=500,
            direction="forward",
        )
    except httpx.HTTPStatusError as e:
        body = e.response.text.strip()[:500]
        typer.echo(f"{command_name}: loki HTTP {e.response.status_code}: {body}", err=True)
        typer.echo(f"  query: {logql}", err=True)
        raise typer.Exit(code=1) from None
    except httpx.HTTPError as e:
        typer.echo(f"{command_name}: loki error: {e}", err=True)
        raise typer.Exit(code=1) from None

    initial.sort(key=lambda e: e.ts_ns)
    for entry in initial:
        _print_entry(entry, timestamps=timestamps)
    if initial:
        sys.stdout.flush()
        last_ts_ns = initial[-1].ts_ns

    try:
        while True:
            time.sleep(_FOLLOW_POLL_INTERVAL)
            now_ns = int(time.time()) * 1_000_000_000
            try:
                entries = loki.query_range(
                    base_url=base_url,
                    logql=logql,
                    start_ns=last_ts_ns + 1,
                    end_ns=now_ns,
                    limit=1000,
                    direction="forward",
                )
            except httpx.HTTPStatusError as e:
                body = e.response.text.strip()[:200]
                typer.echo(
                    f"\n{command_name}: loki HTTP {e.response.status_code}: {body}", err=True
                )
                continue
            except httpx.HTTPError as e:
                typer.echo(f"\n{command_name}: loki error: {e}", err=True)
                continue
            entries.sort(key=lambda e: e.ts_ns)
            for entry in entries:
                _print_entry(entry, timestamps=timestamps)
            if entries:
                sys.stdout.flush()
                last_ts_ns = entries[-1].ts_ns
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        sys.stdout.flush()


def is_direct_host(selector: str) -> bool:
    """selector — прямой host-паттерн (sl-N / wb-N / dt-N / wb-clusters / wb-positions)?"""
    return bool(_DIRECT_HOST_RE.fullmatch(selector))


def _selector_to_host(selector: str, *, command_name: str) -> str:
    """sl-N / wb-N / dt-N / wb-clusters / wb-positions → as-is; иначе resolver → sl-N."""
    if _DIRECT_HOST_RE.fullmatch(selector):
        return selector
    try:
        n, _ = resolve_server(selector)
    except ResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None
    return f"sl-{n}"


def _time_range(since: str | None, *, command_name: str) -> tuple[int, int]:
    """`(start_ns, end_ns)`. По умолчанию — последние 5 минут до now."""
    now_s = int(time.time())
    if since is None:
        start_s = now_s - _DEFAULT_SINCE_SECONDS
    else:
        try:
            start_s = parse_since(since)
        except DurationParseError as e:
            typer.echo(f"{command_name}: --since: {e}", err=True)
            raise typer.Exit(code=2) from None
    return start_s * 1_000_000_000, now_s * 1_000_000_000


def _build_logql(
    *,
    host: str | None,
    service: str | None,
    level: str | None,
    no_stdout: bool,
    no_stderr: bool,
    grep: list[str],
    grep_regex: list[str],
    client_id: int | None,
) -> str:
    """Сборка LogQL: `{labels} | line_filters`.

    `grep` → по одному `|=` (литеральная подстрока) на каждый элемент;
    `grep_regex` → по одному `|~` (regex) на каждый. Несколько фильтров
    AND-ятся (как отдельные contains-клаузы в Grafana).
    """
    label_parts: list[str] = []
    if host is not None:
        label_parts.append(f'host="{_escape_label(host)}"')
    else:
        label_parts.append('host=~".+"')
    if service is not None:
        label_parts.append(f'compose_service="{_escape_label(service)}"')
    if no_stdout:
        label_parts.append('stream!="stdout"')
    if no_stderr:
        label_parts.append('stream!="stderr"')

    selector_str = "{" + ",".join(label_parts) + "}"
    parts = [selector_str]
    for needle in grep:
        parts.append(f"|= {_quote_line_filter(needle)}")
    for pattern in grep_regex:
        parts.append(f"|~ {_quote_line_filter(pattern)}")
    if client_id is not None:
        parts.append(f"|= {_quote_line_filter(str(client_id))}")
    if level is not None:
        parts.append(f'| detected_level="{_escape_label(level.lower())}"')
    return " ".join(parts)


def _escape_label(value: str) -> str:
    """Экранирование для label-value в LogQL: `\\` и `"`."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _quote_line_filter(value: str) -> str:
    """Backtick-quoted строка для line filter — обходит экранирование внутри."""
    if "`" in value:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return f"`{value}`"


def _format_ts(ts_ns: int) -> str:
    """ns → ISO-8601 в UTC с миллисекундами (как docker logs --timestamps)."""
    s, ns_rem = divmod(ts_ns, 1_000_000_000)
    ms = ns_rem // 1_000_000
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(s)) + f".{ms:03d}Z"


def cached_hosts() -> list[str]:
    """Hosts из SQLite-кэша `loki_hosts`. Пустой список если кэш ещё не заполнен."""
    try:
        with store.store() as conn:
            rows = conn.execute("SELECT host FROM loki_hosts ORDER BY host").fetchall()
    except sqlite3.Error:
        return []
    return [r["host"] for r in rows]


def cached_services_for_host(host: str) -> list[str]:
    """Services для конкретного host из SQLite-кэша `loki_services_by_host`."""
    try:
        with store.store() as conn:
            rows = conn.execute(
                "SELECT service FROM loki_services_by_host WHERE host = ? ORDER BY service",
                (host,),
            ).fetchall()
    except sqlite3.Error:
        return []
    return [r["service"] for r in rows]


def cached_all_services() -> list[str]:
    """Все уникальные compose_service из кэша (для autocomplete без явного host)."""
    try:
        with store.store() as conn:
            rows = conn.execute(
                "SELECT DISTINCT service FROM loki_services_by_host ORDER BY service"
            ).fetchall()
    except sqlite3.Error:
        return []
    return [r["service"] for r in rows]


def print_hosts_ls(*, command_name: str) -> None:
    """`mpu logs ls` — печатает hosts из кэша. Подсказывает `mpu init` если пусто."""
    hosts = cached_hosts()
    if not hosts:
        typer.echo(
            f"{command_name}: кэш hosts пуст. Запусти `mpu init` или `mpu update`.",
            err=True,
        )
        raise typer.Exit(code=2)
    for h in hosts:
        typer.echo(h)


def print_all_services_ls(*, command_name: str) -> None:
    """`mpu logs ls` (без host) — все уникальные services из кэша."""
    services = cached_all_services()
    if not services:
        typer.echo(
            f"{command_name}: кэш services пуст. Запусти `mpu init` или `mpu update`.",
            err=True,
        )
        raise typer.Exit(code=2)
    for s in services:
        typer.echo(s)


def print_services_ls(host: str, *, command_name: str) -> None:
    """`mpu logs <host> ls` — печатает services для host из кэша."""
    services = cached_services_for_host(host)
    if not services:
        typer.echo(
            f"{command_name}: для host={host!r} нет services в кэше. "
            f"Проверь host через `mpu logs ls` или обнови кэш через `mpu update`.",
            err=True,
        )
        raise typer.Exit(code=2)
    for s in services:
        typer.echo(s)
