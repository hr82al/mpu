"""Helper'ы для команд, печатающих обёртку над `node <entry> <type>:<name> <method>`.

Команда печатается в stdout и копируется в clipboard. Не выполняется.
Цель библиотеки — убрать boilerplate (resolve, pick, ip+user lookup, quoting, print+copy)
из typer-команд, оставив каждой команде только декларацию её собственных флагов.

Обёртки:
- `wrapper="ssh"` (default) → `ssh -i ... user@ip 'docker exec -it mp-sl-N-cli sh -c "..."'`
- `wrapper="local"` (`--local`) → `sl-N-cli sh -c "..."`
- `wrapper="portainer"` (env `MPU_WRAPPER=portainer`, ставится `mpup-*` entry-point'ами)
  → `mpup-ssh <selector> --no-stdin -- node ...`. `mpup-ssh` сам выбирает Portainer/ssh
  по `~/.config/mpu/.env` — эта строка лишь готова к запуску.

`MPU_WRAPPER` переопределяет `wrapper` в `emit_node_cli` и снимает требование
sl_ip/PG_MY_USER_NAME в `resolve_selector` — это позволяет иметь зеркальные `mpup-*`
bin'ы без дублирования typer-команд.

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

import os
import re
import shlex
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, get_args

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
Wrapper = Literal["ssh", "local", "portainer"]

# Глобальный override обёртки через env. Используется `mpup-*` entry-point'ами:
# каждый ставит `MPU_WRAPPER=portainer` и переиспользует тот же `app()` что и `mpu-*`.
# Нет смысла дублировать typer-команды — env-флаг подменяет финальный wrapper в `emit_node_cli`
# и снимает требование sl_ip/PG_MY_USER_NAME в `resolve_selector`.
WRAPPER_ENV = "MPU_WRAPPER"

# None / False → флаг пропускается.
# True → флаг печатается без значения (boolean).
# str / int → одиночный токен после флага.
# Sequence[str|int] → несколько токенов через пробел (sl-back parseMethodArgs читает массивом).
FlagValue = str | int | bool | Sequence[str | int] | None


@dataclass(frozen=True, slots=True)
class Resolved:
    """Результат resolve_selector. sl_ip/user заполнены только при require_ssh=True.

    `selector` — оригинальный аргумент, который пользователь дал команде (`12345`,
    `"Тортуга"`, `sl-3`). Используется portainer-обёрткой, чтобы передать тот же
    селектор в `mpup-ssh`. Default `""` для обратной совместимости с прямыми
    конструкторами в тестах.
    """

    server_number: int
    sl_ip: str | None
    user: str | None
    candidates: list[dict[str, object]]
    selector: str = ""


def _wrapper_override() -> Wrapper | None:
    """Прочитать `MPU_WRAPPER` и вернуть валидное значение либо None."""
    raw = os.environ.get(WRAPPER_ENV)
    if raw is None:
        return None
    if raw in get_args(Wrapper):
        return raw  # type: ignore[return-value]  # narrowed by membership check
    return None


def _effective_require_ssh(require_ssh: bool) -> bool:
    """Снизить `require_ssh` до False, если env-override указывает на не-ssh wrapper."""
    override = _wrapper_override()
    if override in ("local", "portainer"):
        return False
    return require_ssh


def resolve_selector(
    *,
    value: str,
    server: str | None,
    command_name: str,
    require_ssh: bool = True,
) -> Resolved:
    """Резолв селектора + (опционально) sl_ip/PG_MY_USER_NAME из ~/.config/mpu/.env.

    `require_ssh=False` пропускает lookup sl_ip/user — нужно для wrapper="local"/"portainer".
    Env `MPU_WRAPPER=local|portainer` тоже снимает требование (используется `mpup-*` bin'ами).
    На любой ошибке печатает в stderr и вызывает typer.Exit(2).
    """
    require_ssh = _effective_require_ssh(require_ssh)
    try:
        server_number, candidates = resolve_server(value, server_override=server)
    except ResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(_format_candidates(e.candidates), err=True)
        raise typer.Exit(code=2) from None

    selector = value or server or f"sl-{server_number}"

    if not require_ssh:
        return Resolved(
            server_number=server_number,
            sl_ip=None,
            user=None,
            candidates=candidates,
            selector=selector,
        )

    ip = servers.sl_ip(server_number)
    if ip is None:
        typer.echo(f"{command_name}: no sl_{server_number} in ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)
    user = servers.env_value("PG_MY_USER_NAME")
    if not user:
        typer.echo(f"{command_name}: PG_MY_USER_NAME not set in ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)

    return Resolved(
        server_number=server_number,
        sl_ip=ip,
        user=user,
        candidates=candidates,
        selector=selector,
    )


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
    """Сборка inner-команды + ssh/local/portainer обёртка, typer.echo + copy_to_clipboard."""
    inner = _build_inner(
        entry=entry, type_=type_, name=name, method=method, flags=flags, command_name=command_name
    )
    effective = _wrapper_override() or wrapper
    if effective == "ssh":
        cmd = _wrap_ssh(inner=inner, resolved=resolved, command_name=command_name)
    elif effective == "portainer":
        cmd = _wrap_portainer(inner=inner, resolved=resolved)
    else:
        cmd = _wrap_local(inner=inner, server_number=resolved.server_number)
    typer.echo(cmd)
    copy_to_clipboard(cmd)
    return cmd


def run_with_wrapper(app: typer.Typer, wrapper: Wrapper) -> None:
    """Поднять `MPU_WRAPPER` и вызвать typer-app. Используется `mpup-*` entry-point'ами.

    Не сбрасываем env обратно: процесс CLI завершается сразу после `app()`.
    """
    os.environ[WRAPPER_ENV] = wrapper
    app()


def attach_selector_callback(*, app: typer.Typer, command_name: str) -> None:
    """App-level callback: positional `selector` + `--local`. Subcommands читают `ctx.obj`.

    Поведение:
      - `<bin> <selector> <subcommand> [args]` — селектор перед subcommand.
      - `selector` принимает `sl-N` либо client_id/spreadsheet_id substring/title substring
        (резолвится через `resolve_server` универсально).
      - `--local` — общий для всех subcommand'ов флаг.

    Subcommand читает резолв через `resolve_from_ctx(ctx)`.
    """

    @app.callback()
    def _cb(  # pyright: ignore[reportUnusedFunction]
        ctx: typer.Context,
        selector: Annotated[
            str,
            typer.Argument(help="sl-N либо client_id / spreadsheet_id substring / title substring"),
        ],
        local: Annotated[
            bool,
            typer.Option("--local", help="Local form: sl-N-cli sh -c '...' (без ssh)"),
        ] = False,
    ) -> None:
        ctx.ensure_object(dict)
        # ctx.obj типизирован typer'ом как Any; явно аннотируем после ensure_object().
        obj: dict[str, object] = ctx.obj
        obj["selector"] = selector
        obj["local"] = local
        obj["command_name"] = command_name


def resolve_from_ctx(ctx: typer.Context) -> tuple[Resolved, Wrapper]:
    """Прочитать selector/local/command_name из ctx.obj и резолвнуть.

    Возвращает `(Resolved, wrapper)` где wrapper готов для `emit_node_cli`.
    """
    obj: dict[str, object] = ctx.obj
    selector_raw = obj["selector"]
    local_raw = obj["local"]
    cn_raw = obj["command_name"]
    assert isinstance(selector_raw, str)
    assert isinstance(local_raw, bool)
    assert isinstance(cn_raw, str)
    resolved = resolve_selector(
        value=selector_raw, server=None, command_name=cn_raw, require_ssh=not local_raw
    )
    wrapper: Wrapper = "local" if local_raw else "ssh"
    return resolved, wrapper


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


def _wrap_portainer(*, inner: str, resolved: Resolved) -> str:
    """`mpup-ssh <selector> --no-stdin -- node ...` — выполнение через mpup-ssh.

    `mpup-ssh` выбирает Portainer/ssh transparently из `~/.config/mpu/.env`. Эта обёртка
    лишь конструирует строку для ручного запуска (не выполняет). Селектор берётся из
    `resolved.selector` — оригинальный аргумент пользователя; если его нет (пустой
    `value` в `resolve_server_only`), фоллбек на `sl-N`. `shlex.quote` страхует от
    пробелов / не-ASCII в title-селекторах.
    """
    selector = resolved.selector or f"sl-{resolved.server_number}"
    return f"mpup-ssh {shlex.quote(selector)} --no-stdin -- {inner}"
