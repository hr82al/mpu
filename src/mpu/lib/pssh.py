"""Transport abstraction: запуск команды внутри `mp-sl-N-cli`.

Транспорт выбирается per-server:
  - `portainer` если есть таргет (SQLite после `mpu init` или `sl_<N>_portainer` в .env)
    плюс `PORTAINER_API_KEY`;
  - `ssh` если в `~/.config/mpu/.env` есть `sl_<N>=<ip>` и `PG_MY_USER_NAME`.

**Default — Portainer**, если оба источника заданы. Override через `via="ssh"|"portainer"`.
Причина: Portainer — единственный универсальный путь до всех серверов фермы; ssh
доступен только до части. Унифицируем поведение `mpu p ssh` / `mpu run-js --all`.

stdout/stderr выполняемой команды пишутся напрямую в `sys.stdout.buffer` / `sys.stderr.buffer`,
так что вызов indistinguishable от обычного subprocess: stream'ятся по мере прихода.
"""

import shlex
import signal
import subprocess
import sys
from pathlib import Path
from typing import Literal

import typer

from mpu.lib import containers, portainer, servers

Transport = Literal["ssh", "portainer"]

_STDIN_TMP_NAME = "__MPU_PSSH_STDIN"
_STDIN_TMP_PATH = f"/tmp/{_STDIN_TMP_NAME}"

# Файл с PID запущенной команды в контейнерной PID-namespace. Используем чтобы
# на Ctrl+C из локального процесса послать `kill -INT` второму exec'у. Просто
# закрытия WS-соединения недостаточно: Docker НЕ шлёт SIGHUP exec-процессу при
# disconnect (проверено эмпирически даже с Tty=true).
_PIDFILE = "/tmp/__MPU_PSSH_PID"


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


def pssh_run_container(
    *,
    container: str,
    cmd: list[str],
    stdin: bytes = b"",
) -> int:
    """Выполнить cmd в произвольном контейнере по точному имени; вернуть exit code.

    Транспорт — всегда Portainer: для контейнеров без `server_number` (например
    `mp-dt-cli`) sl-N маппинга нет, а на ssh-side у нас нет per-container ключей
    и pg-credentials. Если нужно `mp-sl-N-cli` через ssh — используй `pssh_run`.

    На неоднозначное имя (несколько Portainer-endpoint'ов с тем же `container_name`)
    или отсутствие — бросает `containers.ContainerResolveError` (вызывающий код
    форматирует и решает, fall back на `mpu search` или показать ошибку).
    """
    base_url, endpoint_id = containers.resolve_container_target(container)
    api_key = servers.env_value("PORTAINER_API_KEY")
    if not api_key:
        typer.echo(
            "mpu p ssh: PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    return run_in_container_via_portainer(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        container=container,
        cmd=cmd,
        stdin=stdin,
        verify_tls=verify_tls,
    )


def _resolve_transport(n: int, via: str | None) -> Transport:
    if via == "ssh" or via == "portainer":
        return via
    if via is not None:
        typer.echo(
            f"mpu p ssh: --via должен быть ssh|portainer, получено {via!r}",
            err=True,
        )
        raise typer.Exit(code=2)
    has_ssh = servers.sl_ip(n) is not None and servers.env_value("PG_MY_USER_NAME") is not None
    has_ptr = (
        servers.portainer_target(n) is not None
        and servers.env_value("PORTAINER_API_KEY") is not None
    )
    # Portainer-first: единый путь до всей фермы; ssh — fallback для legacy конфигов.
    if has_ptr:
        return "portainer"
    if has_ssh:
        return "ssh"
    typer.echo(
        f"mpu p ssh: для sl-{n} не задано ни sl_{n} (+PG_MY_USER_NAME) "
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
    full = f"ssh -i {key} {user}@{ip} 'docker exec -i {container} sh -c {shlex.quote(inner)}'"
    result = subprocess.run(["bash", "-c", full], input=stdin, check=False)
    return result.returncode


def _run_via_portainer(n: int, cmd: list[str], stdin: bytes) -> int:
    target = servers.portainer_target(n)
    api_key = servers.env_value("PORTAINER_API_KEY")
    assert target is not None and api_key is not None
    base_url, endpoint_id = target
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    return run_in_container_via_portainer(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        container=f"mp-sl-{n}-cli",
        cmd=cmd,
        stdin=stdin,
        verify_tls=verify_tls,
    )


def run_in_container_via_portainer(
    *,
    base_url: str,
    endpoint_id: int,
    api_key: str,
    container: str,
    cmd: list[str],
    stdin: bytes = b"",
    verify_tls: bool = False,
) -> int:
    """Ws-exec в произвольный Portainer-контейнер; стримит stdio; вернуть exit code.

    Включает PID-файл (для kill при Ctrl+C), upload tar для stdin, и cleanup
    pidfile/stdin в `finally`. Используется как `mp-sl-{N}-cli` (через
    `_run_via_portainer`), так и `mp-dt-cli` (через `mp_dt.run_in_mp_dt_cli`).
    """
    # Восстанавливаем дефолтный SIGINT handler. Если bash backgrounding (`&`) или
    # другой parent установил SIGINT=SIG_IGN до exec'а, Python не восстанавливает
    # его сам, и Ctrl+C в нашем процессе становится no-op. Без этого `kill -INT`
    # на mpu p process не вызывает KeyboardInterrupt, и remote-cleanup в except
    # не сработает.
    signal.signal(signal.SIGINT, signal.default_int_handler)

    client = portainer.Client(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        verify_tls=verify_tls,
    )

    # Оборачиваем команду: `sh -c 'echo $$ > pidfile; exec <inner>'`. `exec` заменяет
    # sh реальной командой с тем же PID, поэтому pidfile содержит PID именно команды
    # (node/sleep/etc). `kill $(cat pidfile)` шлёт сигнал прямо в неё, а не в
    # промежуточный sh — иначе настоящий процесс осиротел бы и пережил отмену.
    inner = " ".join(shlex.quote(a) for a in cmd)
    if stdin:
        client.upload_tar(container, "/tmp", {_STDIN_TMP_NAME: stdin})
        inner = f"{inner} < {_STDIN_TMP_PATH}"
    final_cmd = ["sh", "-c", f"echo $$ > {_PIDFILE}; exec {inner}"]

    # Flush после каждого чанка: sys.stdout.buffer — BufferedWriter с блочным буфером
    # (~8 KB), line-buffering у TextIOWrapper в обход. Без flush'а вывод копится,
    # пока буфер не наполнится, и команда выглядит зависшей.
    def _write_stdout(b: bytes) -> None:
        sys.stdout.buffer.write(b)
        sys.stdout.buffer.flush()

    def _write_stderr(b: bytes) -> None:
        sys.stderr.buffer.write(b)
        sys.stderr.buffer.flush()

    interrupted = False
    try:
        # TTY=True заставляет Node-внутри-контейнера переключить process.stdout
        # на синхронные write'ы (POSIX-поведение), иначе он батчит console.log
        # пакетами до ~16 KB и пользователь видит бурсты вместо построчного стрима.
        # Trade-off: stdout/stderr приходят одним потоком без 8-byte framing'а.
        exec_id = client.create_exec(container, final_cmd, tty=True)
        try:
            client.start_exec_stream(
                exec_id, on_stdout=_write_stdout, on_stderr=_write_stderr, tty=True
            )
        except KeyboardInterrupt:
            # Закрытие WS НЕ вызывает SIGHUP в Docker exec — нужно явно убить процесс
            # вторым exec'ом. Сообщаем пользователю, что мы не просто бросили команду.
            sys.stderr.write("\nmpu: Ctrl+C → killing remote process...\n")
            sys.stderr.flush()
            interrupted = True
            _kill_remote_process(client, container)
            raise
        return client.inspect_exec_exit_code(exec_id)
    finally:
        # Cleanup pidfile + stdin tar даже после Ctrl+C — иначе следующий запуск может
        # подцепить устаревший pidfile (race), а stdin file висит до рестарта контейнера.
        _best_effort_cleanup(client, container, with_stdin=bool(stdin), suppress=interrupted)


def _kill_remote_process(client: portainer.Client, container: str) -> None:
    """SIGINT → SIGKILL процессу, чей PID лежит в /tmp/__MPU_PSSH_PID.

    `kill -0` тест бесполезен (gone race), поэтому шлём INT, ждём 1 секунду
    на graceful shutdown, затем KILL. Errors глотаем — на Ctrl+C главное не
    зависнуть, а не диагностировать корректный exit. После kill'а pidfile
    подчищает `_best_effort_cleanup` в finally вызывающего.
    """
    script = (
        f"PID=$(cat {_PIDFILE} 2>/dev/null); "
        f'[ -n "$PID" ] || exit 0; '
        f'kill -INT "$PID" 2>/dev/null; '
        f"sleep 1; "
        f'kill -KILL "$PID" 2>/dev/null; '
        f"exit 0"
    )
    try:
        kill_id = client.create_exec(container, ["sh", "-c", script])
        client.start_exec_stream(
            kill_id,
            on_stdout=lambda _b: None,
            on_stderr=lambda _b: None,
        )
    except Exception:
        # best-effort: на Ctrl+C UX важнее чем корректный shutdown — не задерживаемся
        pass


def _best_effort_cleanup(
    client: portainer.Client,
    container: str,
    *,
    with_stdin: bool,
    suppress: bool = False,
) -> None:
    """rm -f /tmp/__MPU_PSSH_PID (+ stdin tar если был). Файлы живут до рестарта."""
    paths = [_PIDFILE]
    if with_stdin:
        paths.append(_STDIN_TMP_PATH)
    try:
        cleanup_id = client.create_exec(container, ["rm", "-f", *paths])
        client.start_exec_stream(
            cleanup_id,
            on_stdout=lambda _b: None,
            on_stderr=lambda _b: None,
        )
    except Exception:
        # best-effort cleanup — файлы живут до рестарта контейнера, не критично
        if not suppress:
            pass
