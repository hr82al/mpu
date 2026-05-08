"""Transport abstraction: запуск команды внутри `mp-sl-N-cli`.

Транспорт выбирается per-server:
  - `ssh` если в `~/.config/mpu/.env` есть `sl_<N>=<ip>` и `PG_MY_USER_NAME`;
  - `portainer` если есть `sl_<N>_portainer=<base_url>/<endpoint_id>` и `PORTAINER_API_KEY`.

Если оба заданы — приоритет ssh (быстрее, проще). Override через `via="ssh"|"portainer"`.

stdout/stderr выполняемой команды пишутся напрямую в `sys.stdout.buffer` / `sys.stderr.buffer`,
так что вызов indistinguishable от обычного subprocess: stream'ятся по мере прихода.
"""

import shlex
import subprocess
import sys
from pathlib import Path
from typing import Literal

import typer

from mpu.lib import portainer, servers

Transport = Literal["ssh", "portainer"]

_STDIN_TMP_NAME = "__MPU_PSSH_STDIN"
_STDIN_TMP_PATH = f"/tmp/{_STDIN_TMP_NAME}"


def pssh_run(
    *,
    server_number: int,
    cmd: list[str],
    stdin: bytes = b"",
    via: str | None = None,
) -> int:
    """Выполнить cmd внутри `mp-sl-{server_number}-cli`; вернуть exit code."""
    transport = _resolve_transport(server_number, via)
    if transport == "ssh":
        return _run_via_ssh(server_number, cmd, stdin)
    return _run_via_portainer(server_number, cmd, stdin)


def _resolve_transport(n: int, via: str | None) -> Transport:
    if via == "ssh" or via == "portainer":
        return via
    if via is not None:
        typer.echo(
            f"mpu-pssh: --via должен быть ssh|portainer, получено {via!r}",
            err=True,
        )
        raise typer.Exit(code=2)
    has_ssh = (
        servers.sl_ip(n) is not None and servers.env_value("PG_MY_USER_NAME") is not None
    )
    has_ptr = (
        servers.portainer_target(n) is not None
        and servers.env_value("PORTAINER_API_KEY") is not None
    )
    if has_ssh:
        return "ssh"
    if has_ptr:
        return "portainer"
    typer.echo(
        f"mpu-pssh: для sl-{n} не задано ни sl_{n} (+PG_MY_USER_NAME) "
        f"ни sl_{n}_portainer (+PORTAINER_API_KEY)",
        err=True,
    )
    raise typer.Exit(code=2)


def _run_via_ssh(n: int, cmd: list[str], stdin: bytes) -> int:
    ip = servers.sl_ip(n)
    user = servers.env_value("PG_MY_USER_NAME")
    assert ip is not None and user is not None  # _resolve_transport уже проверил
    key = str(Path.home() / ".ssh" / "id_rsa")
    container = f"mp-sl-{n}-cli"
    inner = " ".join(shlex.quote(a) for a in cmd)
    full = (
        f"ssh -i {key} {user}@{ip} "
        f"'docker exec -i {container} sh -c {shlex.quote(inner)}'"
    )
    result = subprocess.run(["bash", "-c", full], input=stdin, check=False)
    return result.returncode


def _run_via_portainer(n: int, cmd: list[str], stdin: bytes) -> int:
    target = servers.portainer_target(n)
    api_key = servers.env_value("PORTAINER_API_KEY")
    assert target is not None and api_key is not None
    base_url, endpoint_id = target
    container = f"mp-sl-{n}-cli"
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"

    client = portainer.Client(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        verify_tls=verify_tls,
    )

    final_cmd = cmd
    if stdin:
        client.upload_tar(container, "/tmp", {_STDIN_TMP_NAME: stdin})
        cmd_str = " ".join(shlex.quote(a) for a in cmd)
        final_cmd = ["sh", "-c", f"{cmd_str} < {_STDIN_TMP_PATH}"]

    def _write_stdout(b: bytes) -> None:
        sys.stdout.buffer.write(b)

    def _write_stderr(b: bytes) -> None:
        sys.stderr.buffer.write(b)

    try:
        exec_id = client.create_exec(container, final_cmd)
        client.start_exec_stream(exec_id, on_stdout=_write_stdout, on_stderr=_write_stderr)
        sys.stdout.buffer.flush()
        sys.stderr.buffer.flush()
        return client.inspect_exec_exit_code(exec_id)
    finally:
        if stdin:
            _best_effort_cleanup(client, container)


def _best_effort_cleanup(client: portainer.Client, container: str) -> None:
    """Удалить /tmp/__MPU_PSSH_STDIN. Любые ошибки молча проглатываем — файл живёт до рестарта."""
    try:
        cleanup_id = client.create_exec(container, ["rm", "-f", _STDIN_TMP_PATH])
        client.start_exec_stream(
            cleanup_id,
            on_stdout=lambda _b: None,
            on_stderr=lambda _b: None,
        )
    except Exception:
        # best-effort cleanup — файл живёт до рестарта контейнера, не критично
        pass
