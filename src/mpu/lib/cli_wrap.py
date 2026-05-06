"""Helper'ы для команд, печатающих ssh+docker обёртку над `node <entry> <type>:<name> <method>`.

Команда печатается в stdout и копируется в clipboard. Не выполняется.
Цель библиотеки — убрать boilerplate (resolve, pick, ip+user lookup, quoting, print+copy)
из typer-команд, оставив каждой команде только декларацию её собственных флагов.

Типичный консьюмер:

    @app.command()
    def main(
        value: Annotated[str, typer.Argument(...)],
        server: Annotated[str | None, typer.Option("--server")] = None,
        local: Annotated[bool, typer.Option("--local")] = False,
        client_id: Annotated[int | None, typer.Option("--client-id", "--client_id")] = None,
        # ... доменные флаги ...
    ) -> None:
        resolved = resolve_selector(
            value=value, server=server, command_name=COMMAND_NAME, require_ssh=not local
        )
        cid = require(
            client_id if client_id is not None else auto_pick_int(resolved.candidates, "client_id"),
            flag="--client-id", candidates=resolved.candidates, command_name=COMMAND_NAME,
        )
        emit_node_cli(
            name="ssUpdater", method="update",
            flags={"--client-id": cid, ...},
            resolved=resolved,
            wrapper="local" if local else "ssh",
            command_name=COMMAND_NAME,
        )
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import typer

from mpu.lib import servers
from mpu.lib.clipboard import copy_to_clipboard
from mpu.lib.resolver import ResolveError, resolve_server

# Whitelist для значений, попадающих в shell-обёртку.
# Запрещаем spaces, $, `, ', ", \, ;, &, |, (, ), {, } —
# quoting инвариант строится на их отсутствии.
# Разрешаем `[` `]` для JSON-массивов вида `[1,2,3]` (без пробелов) и `@` для email.
_SAFE_TOKEN = re.compile(r"\A[A-Za-z0-9_./:\-,@\[\]]+\Z")

EntryPoint = Literal["cli", "sl-main", "sl-instance", "wb-main", "wb-instance"]
DispatchType = Literal["service", "model", "dataset", "proxy"]
Wrapper = Literal["ssh", "local"]

# None / False → флаг пропускается.
# True → флаг печатается без значения (boolean).
# str / int → одиночный токен после флага.
# Sequence[str|int] → несколько токенов через пробел (sl-back parseMethodArgs читает массивом).
FlagValue = str | int | bool | Sequence[str | int] | None


@dataclass(frozen=True, slots=True)
class Resolved:
    """Результат resolve_selector. sl_ip/user заполнены только при require_ssh=True."""

    server_number: int
    sl_ip: str | None
    user: str | None
    candidates: list[dict[str, object]]


def resolve_selector(
    *,
    value: str,
    server: str | None,
    command_name: str,
    require_ssh: bool = True,
) -> Resolved:
    """Резолв селектора + (опционально) sl_ip/PG_MY_USER_NAME из ~/.config/mpu/.env.

    `require_ssh=False` пропускает lookup sl_ip/user — нужно для wrapper="local".
    На любой ошибке печатает в stderr и вызывает typer.Exit(2).
    """
    try:
        server_number, candidates = resolve_server(value, server_override=server)
    except ResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    if not require_ssh:
        return Resolved(server_number=server_number, sl_ip=None, user=None, candidates=candidates)

    ip = servers.sl_ip(server_number)
    if ip is None:
        typer.echo(f"{command_name}: no sl_{server_number} in ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)
    user = servers.env_value("PG_MY_USER_NAME")
    if not user:
        typer.echo(f"{command_name}: PG_MY_USER_NAME not set in ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)

    return Resolved(server_number=server_number, sl_ip=ip, user=user, candidates=candidates)


def resolve_server_only(
    *,
    server: str,
    command_name: str,
    require_ssh: bool = True,
) -> Resolved:
    """Резолв только по `--server sl-N` без client/spreadsheet selector.

    Для команд без `client_id` (jobs, app-migrations, users): SQLite-поиск пропускается,
    `candidates` всегда пустой. Если `server` пустой — `typer.Exit(2)`.
    """
    if not server:
        typer.echo(f"{command_name}: --server is required", err=True)
        raise typer.Exit(code=2)
    return resolve_selector(
        value="", server=server, command_name=command_name, require_ssh=require_ssh
    )


def auto_pick_int(candidates: list[dict[str, object]], field: str) -> int | None:
    """Если все кандидаты дают одно и то же `int`-значение под `field` — вернуть его."""
    distinct = {v for c in candidates if isinstance(v := c.get(field), int)}
    return next(iter(distinct)) if len(distinct) == 1 else None


def auto_pick_str(candidates: list[dict[str, object]], field: str) -> str | None:
    """Аналог auto_pick_int для строковых полей (например spreadsheet_id)."""
    distinct = {v for c in candidates if isinstance(v := c.get(field), str)}
    return next(iter(distinct)) if len(distinct) == 1 else None


def require[T](
    value: T | None,
    *,
    flag: str,
    candidates: list[dict[str, object]],
    command_name: str,
) -> T:
    """value None → typer.Exit(2) с печатью кандидатов; иначе вернуть value (типизированно)."""
    if value is None:
        typer.echo(
            f"{command_name}: cannot resolve {flag} from selector; pass {flag}",
            err=True,
        )
        if candidates:
            typer.echo(_format_candidates(candidates), err=True)
        raise typer.Exit(code=2)
    return value


def emit_node_cli(
    *,
    name: str,
    method: str,
    flags: dict[str, FlagValue],
    resolved: Resolved,
    type_: DispatchType = "service",
    entry: EntryPoint = "cli",
    wrapper: Wrapper = "ssh",
    command_name: str,
) -> str:
    """Сборка inner-команды + ssh/local обёртка, typer.echo + copy_to_clipboard, возврат строки."""
    inner = _build_inner(
        entry=entry, type_=type_, name=name, method=method, flags=flags, command_name=command_name
    )
    if wrapper == "ssh":
        cmd = _wrap_ssh(inner=inner, resolved=resolved, command_name=command_name)
    else:
        cmd = _wrap_local(inner=inner, server_number=resolved.server_number)
    typer.echo(cmd)
    copy_to_clipboard(cmd)
    return cmd


# ── private ──────────────────────────────────────────────────────────────────


def _check_safe(flag: str, value: str, *, command_name: str) -> None:
    if not _SAFE_TOKEN.fullmatch(value):
        typer.echo(
            f"{command_name}: value contains shell-unsafe chars for {flag}: {value!r}",
            err=True,
        )
        raise typer.Exit(code=2)


def _format_candidates(candidates: list[dict[str, object]]) -> str:
    lines: list[str] = []
    for c in candidates:
        client_id = c.get("client_id")
        server = c.get("server")
        title = c.get("title")
        ss = c.get("spreadsheet_id")
        parts = [f"client_id={client_id}", f"server={server}"]
        if title:
            parts.append(f'title="{title}"')
        if ss:
            parts.append(f"spreadsheet_id={ss}")
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)


def _kebab(flag_name: str) -> str:
    """Канонический dash-формат флага. Допустимы и `client_id`, и `--client_id`, и `--client-id`."""
    s = flag_name.removeprefix("--").replace("_", "-")
    return f"--{s}"


def _emit_value(flag: str, v: str | int, *, command_name: str) -> str:
    s = str(v)
    _check_safe(flag, s, command_name=command_name)
    return s


def _build_inner(
    *,
    entry: EntryPoint,
    type_: DispatchType,
    name: str,
    method: str,
    flags: dict[str, FlagValue],
    command_name: str,
) -> str:
    parts: list[str] = ["node", entry, f"{type_}:{name}", method]
    for raw_flag, value in flags.items():
        if value is None or value is False:
            continue
        flag = _kebab(raw_flag)
        if value is True:
            parts.append(flag)
            continue
        if isinstance(value, (str, int)):
            parts += [flag, _emit_value(flag, value, command_name=command_name)]
            continue
        # Sequence: `--flag a b c` — sl-back parseMethodArgs читает как массив.
        emitted = [_emit_value(flag, v, command_name=command_name) for v in value]
        if not emitted:
            continue
        parts += [flag, *emitted]
    return " ".join(parts)


def _wrap_ssh(*, inner: str, resolved: Resolved, command_name: str) -> str:
    if resolved.sl_ip is None or resolved.user is None:
        # Защита: ssh wrapper требует резолва sl_ip/user. Не должно происходить
        # при правильном использовании resolve_selector(require_ssh=True).
        typer.echo(f"{command_name}: internal error — ssh wrapper without sl_ip/user", err=True)
        raise typer.Exit(code=2)
    key_path = str(Path.home() / ".ssh" / "id_rsa")
    container = f"mp-sl-{resolved.server_number}-cli"
    return (
        f"ssh -i {key_path} -t {resolved.user}@{resolved.sl_ip} "
        f"'docker exec -it {container} sh -c \"{inner}\"'"
    )


def _wrap_local(*, inner: str, server_number: int) -> str:
    """`sl-N-cli sh -c "..."` — alias из mp-config-local/aliases.d/40-sl-back.sh.

    Пользователь сам набирает в shell, где alias загружен (`alias sl-N-cli="sl-N exec -it cli"`).
    """
    return f'sl-{server_number}-cli sh -c "{inner}"'
