"""Transport abstraction: запуск команды внутри `mp-sl-N-cli`.

Транспорт выбирается per-server:
  - `portainer` если есть таргет (SQLite после `mpu init` или `sl_<N>_portainer` в .env)
    плюс `PORTAINER_API_KEY`;
  - `ssh` если в `~/.config/mpu/.env` есть `sl_<N>=<ip>` и `PG_MY_USER_NAME`.

**Default — Portainer**, если оба источника заданы. Override через `via="ssh"|"portainer"`.
Причина: Portainer — единственный универсальный путь до всех серверов фермы; ssh
доступен только до части. Унифицируем поведение `mpu ssh` / `mpu run-js --all`.

stdout/stderr выполняемой команды пишутся напрямую в `sys.stdout.buffer` / `sys.stderr.buffer`,
так что вызов indistinguishable от обычного subprocess: stream'ятся по мере прихода.
"""

import shlex
import signal
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Literal

import typer

from mpu.lib import containers, portainer, servers

Transport = Literal["ssh", "portainer"]

# Dev-стенд (`mp-dev`, 192.168.150.8): один хост с контейнерами mp-sl-0/1/2-cli, в
# Portainer-ферму (.12) НЕ входит — достаётся только по ssh под отдельным юзером.
# Транспорт принудительно ssh+docker (минуя `_resolve_transport`).
DEV_NODE_HOST = "192.168.150.8"
DEV_NODE_USER = "develop"

_STDIN_TMP_NAME = "__MPU_PSSH_STDIN"
_STDIN_TMP_PATH = f"/tmp/{_STDIN_TMP_NAME}"

# Файл с PID запущенной команды в контейнерной PID-namespace. Используем чтобы
# на Ctrl+C из локального процесса послать `kill -INT` второму exec'у. Просто
# закрытия WS-соединения недостаточно: Docker НЕ шлёт SIGHUP exec-процессу при
# disconnect (проверено эмпирически даже с Tty=true).
_PIDFILE = "/tmp/__MPU_PSSH_PID"


def _cmd_to_shell(cmd: list[str]) -> str:
    """Превратить переданную команду в строку для `sh -c`.

    Один элемент → это уже готовая shell-командная строка: `mpu ssh sl-5 "VAR=x node cli ..."`.
    Отдаём как есть, чтобы env-присваивания, пайпы и redirect'ы исполнил шелл. `shlex.quote`
    тут схлопнул бы всю строку в один токен, и `exec`/`sh` искали бы программу с таким
    буквальным именем (`... node cli ...: not found`).

    Несколько элементов → argv-форма: `mpu ssh sl-5 -- ls -la /app`. Квотируем каждый,
    чтобы пробелы и спецсимволы внутри отдельного аргумента не разъехались по словам.
    """
    if len(cmd) == 1:
        return cmd[0]
    return " ".join(shlex.quote(a) for a in cmd)


def _ssh_conn(server_number: int, *, dev: bool) -> tuple[str, str, str]:
    """`(host, user, key_path)` для ssh+docker exec. `dev=True` → dev-нода под `develop`."""
    key = str(Path.home() / ".ssh" / "id_rsa")
    if dev:
        host = servers.env_value("DEV_NODE_HOST") or DEV_NODE_HOST
        user = servers.env_value("DEV_NODE_USER") or DEV_NODE_USER
        return host, user, key
    ip = servers.sl_ip(server_number)
    user = servers.env_value("PG_MY_USER_NAME")
    assert ip is not None and user is not None  # _resolve_transport уже проверил
    return ip, user, key


def pssh_run(
    *,
    server_number: int,
    cmd: list[str],
    stdin: bytes = b"",
    via: str | None = None,
    dev: bool = False,
    on_stdout: Callable[[bytes], None] | None = None,
    on_stderr: Callable[[bytes], None] | None = None,
    manage_signals: bool = True,
) -> int:
    """Выполнить cmd внутри `mp-sl-{server_number}-cli`; вернуть exit code.

    `dev=True` — таргет на dev-ноде (`mp-dev`, ssh+docker под `develop`), `via` игнорируется.
    `on_stdout`/`on_stderr` (если заданы) — захват вывода вместо стрима в `sys.stdout`
    (нужен для параллельного fan-out: каждый таргет пишет в свой буфер). `manage_signals`
    выключать при запуске вне главного потока — `signal.signal` доступен только из него.
    """
    if dev:
        return _run_via_ssh(
            server_number, cmd, stdin, dev=True, on_stdout=on_stdout, on_stderr=on_stderr
        )
    transport = _resolve_transport(server_number, via)
    if transport == "ssh":
        return _run_via_ssh(server_number, cmd, stdin, on_stdout=on_stdout, on_stderr=on_stderr)
    return _run_via_portainer(
        server_number,
        cmd,
        stdin,
        on_stdout=on_stdout,
        on_stderr=on_stderr,
        manage_signals=manage_signals,
    )


def pssh_run_container(
    *,
    container: str,
    cmd: list[str],
    stdin: bytes = b"",
    on_stdout: Callable[[bytes], None] | None = None,
    on_stderr: Callable[[bytes], None] | None = None,
    manage_signals: bool = True,
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
            "mpu ssh: PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
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
        on_stdout=on_stdout,
        on_stderr=on_stderr,
        manage_signals=manage_signals,
    )


def _resolve_transport(n: int, via: str | None) -> Transport:
    if via == "ssh" or via == "portainer":
        return via
    if via is not None:
        typer.echo(
            f"mpu ssh: --via должен быть ssh|portainer, получено {via!r}",
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
        f"mpu ssh: для sl-{n} не задано ни sl_{n} (+PG_MY_USER_NAME) "
        f"ни sl_{n}_portainer (+PORTAINER_API_KEY)",
        err=True,
    )
    raise typer.Exit(code=2)


def _run_via_ssh(
    n: int,
    cmd: list[str],
    stdin: bytes,
    *,
    dev: bool = False,
    on_stdout: Callable[[bytes], None] | None = None,
    on_stderr: Callable[[bytes], None] | None = None,
) -> int:
    ip, user, key = _ssh_conn(n, dev=dev)
    container = f"mp-sl-{n}-cli"
    inner = _cmd_to_shell(cmd)
    # remote — единственный позиционный arg ssh: удалённый шелл сам исполнит строку.
    # Передаём argv напрямую (без локального `bash -c`), чтобы не плодить ещё один
    # уровень квотирования поверх ssh+`sh -c`.
    remote = f"docker exec -i {container} sh -c {shlex.quote(inner)}"
    argv = ["ssh", "-i", key, f"{user}@{ip}", remote]
    # При захвате вывода (параллельный fan-out) буферизуем через PIPE и форвардим в
    # переданные колбэки — иначе stdout/stderr разных серверов перемешаются.
    if on_stdout is not None or on_stderr is not None:
        result = subprocess.run(argv, input=stdin, check=False, capture_output=True)
        if on_stdout is not None and result.stdout:
            on_stdout(result.stdout)
        if on_stderr is not None and result.stderr:
            on_stderr(result.stderr)
        return result.returncode
    result = subprocess.run(argv, input=stdin, check=False)
    return result.returncode


def _run_via_portainer(
    n: int,
    cmd: list[str],
    stdin: bytes,
    on_stdout: Callable[[bytes], None] | None = None,
    on_stderr: Callable[[bytes], None] | None = None,
    manage_signals: bool = True,
) -> int:
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
        on_stdout=on_stdout,
        on_stderr=on_stderr,
        manage_signals=manage_signals,
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
    on_stdout: Callable[[bytes], None] | None = None,
    on_stderr: Callable[[bytes], None] | None = None,
    manage_signals: bool = True,
) -> int:
    """Ws-exec в произвольный Portainer-контейнер; стримит stdio; вернуть exit code.

    Включает PID-файл (для kill при Ctrl+C), upload tar для stdin, и cleanup
    pidfile/stdin в `finally`. Используется как `mp-sl-{N}-cli` (через
    `_run_via_portainer`), так и `mp-dt-cli` (через `mp_dt.run_in_mp_dt_cli`).

    `on_stdout`/`on_stderr` (если заданы) перехватывают вывод вместо записи в
    `sys.stdout`/`sys.stderr` — для параллельного fan-out с буфером на таргет.
    `manage_signals=False` — пропустить установку SIGINT-handler'а (обязательно при
    запуске вне главного потока: `signal.signal` бросает `ValueError` в worker-потоке).
    """
    # Восстанавливаем дефолтный SIGINT handler. Если bash backgrounding (`&`) или
    # другой parent установил SIGINT=SIG_IGN до exec'а, Python не восстанавливает
    # его сам, и Ctrl+C в нашем процессе становится no-op. Без этого `kill -INT`
    # на mpu p process не вызывает KeyboardInterrupt, и remote-cleanup в except
    # не сработает. В worker-потоке (параллельный fan-out) пропускаем — signal.signal
    # работает только из главного потока.
    if manage_signals:
        signal.signal(signal.SIGINT, signal.default_int_handler)

    client = portainer.Client(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        verify_tls=verify_tls,
    )

    # Оборачиваем команду: `sh -c 'echo $$ > pidfile; exec sh -c <inner>'`. Внутренний
    # `sh -c` нужен, чтобы <inner> прошёл через шелл — env-присваивания (`VAR=x cmd`),
    # пайпы и redirect'ы не отработают, если отдать строку напрямую в `exec`. `exec`
    # заменяет внешний sh, сохраняя PID; внутренний sh при единственной команде exec'ает
    # её на месте, поэтому pidfile содержит PID самой команды (node/sleep/etc) —
    # `kill $(cat pidfile)` на Ctrl+C попадает в неё, а не в промежуточный процесс.
    inner = _cmd_to_shell(cmd)
    if stdin:
        client.upload_tar(container, "/tmp", {_STDIN_TMP_NAME: stdin})
        inner = f"{inner} < {_STDIN_TMP_PATH}"
    final_cmd = ["sh", "-c", f"echo $$ > {_PIDFILE}; exec sh -c {shlex.quote(inner)}"]

    # Flush после каждого чанка: sys.stdout.buffer — BufferedWriter с блочным буфером
    # (~8 KB), line-buffering у TextIOWrapper в обход. Без flush'а вывод копится,
    # пока буфер не наполнится, и команда выглядит зависшей.
    def _write_stdout(b: bytes) -> None:
        sys.stdout.buffer.write(b)
        sys.stdout.buffer.flush()

    def _write_stderr(b: bytes) -> None:
        sys.stderr.buffer.write(b)
        sys.stderr.buffer.flush()

    out_cb = on_stdout if on_stdout is not None else _write_stdout
    err_cb = on_stderr if on_stderr is not None else _write_stderr

    interrupted = False
    try:
        # TTY=True заставляет Node-внутри-контейнера переключить process.stdout
        # на синхронные write'ы (POSIX-поведение), иначе он батчит console.log
        # пакетами до ~16 KB и пользователь видит бурсты вместо построчного стрима.
        # Trade-off: stdout/stderr приходят одним потоком без 8-byte framing'а.
        exec_id = client.create_exec(container, final_cmd, tty=True)
        try:
            client.start_exec_stream(exec_id, on_stdout=out_cb, on_stderr=err_cb, tty=True)
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


# --- detached launch: процесс переживает закрытие exec/WS (фоновый прогон на сервере) ---

_DETACH_DIR = "/tmp"


def detach_script_paths(run_id: str) -> tuple[str, str]:
    """(script_path, log_path) в /tmp контейнера для данного run_id."""
    return f"{_DETACH_DIR}/mpu-run-{run_id}.mjs", f"{_DETACH_DIR}/mpu-run-{run_id}.log"


def pssh_detach(
    *,
    server_number: int,
    js: bytes,
    run_id: str,
    via: str | None = None,
    dev: bool = False,
) -> tuple[int, str]:
    """Запустить ESM детачем в `mp-sl-{server_number}-cli` — фон, переживающий disconnect.

    Заливает скрипт в `/tmp/mpu-run-{run_id}.mjs`, стартует node в фоне с выводом в
    `/tmp/mpu-run-{run_id}.log` и сразу возвращается. Node переподхватывается init'ом
    контейнера (PID 1) и живёт после закрытия exec/WS/ssh. Возвращает (rc_запуска, log_path).

    `dev=True` — на dev-ноде (ssh+docker под `develop`), `via` игнорируется.
    """
    container = f"mp-sl-{server_number}-cli"
    if dev:
        return _detach_via_ssh(server_number, container, js, run_id, dev=True)
    transport = _resolve_transport(server_number, via)
    if transport == "ssh":
        return _detach_via_ssh(server_number, container, js, run_id)
    target = servers.portainer_target(server_number)
    api_key = servers.env_value("PORTAINER_API_KEY")
    assert target is not None and api_key is not None
    base_url, endpoint_id = target
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    return detach_in_container_via_portainer(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        container=container,
        js=js,
        run_id=run_id,
        verify_tls=verify_tls,
    )


def pssh_detach_container(*, container: str, js: bytes, run_id: str) -> tuple[int, str]:
    """Detached-запуск ESM в произвольном контейнере по имени (всегда Portainer)."""
    base_url, endpoint_id = containers.resolve_container_target(container)
    api_key = servers.env_value("PORTAINER_API_KEY")
    if not api_key:
        typer.echo("mpu run-js: PORTAINER_API_KEY не задан в ~/.config/mpu/.env", err=True)
        raise typer.Exit(code=2)
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    return detach_in_container_via_portainer(
        base_url=base_url,
        endpoint_id=endpoint_id,
        api_key=api_key,
        container=container,
        js=js,
        run_id=run_id,
        verify_tls=verify_tls,
    )


def _portainer_detach_cmd(script_path: str, log_path: str) -> str:
    """sh-команда для Portainer-пути: node в фоне с отвязанным stdio, форграунд выходит.

    `nohup` игнорирует SIGHUP; редирект в лог + `< /dev/null` отвязывают stdio; `&` — фон,
    форграунд-sh тут же выходит → exec завершается, а node переподхватывается PID 1
    контейнера и продолжает работать. (`tty=false` у launch-exec'а → controlling-TTY нет.)
    """
    return (
        f"nohup node {shlex.quote(script_path)} > {shlex.quote(log_path)} 2>&1 < /dev/null & "
        f'echo "mpu: detached, log={log_path}"'
    )


def detach_in_container_via_portainer(
    *,
    base_url: str,
    endpoint_id: int,
    api_key: str,
    container: str,
    js: bytes,
    run_id: str,
    verify_tls: bool = False,
) -> tuple[int, str]:
    """Upload скрипта + короткий detached-exec через Portainer. → (rc_запуска, log_path)."""
    script_path, log_path = detach_script_paths(run_id)
    script_name = Path(script_path).name
    client = portainer.Client(
        base_url=base_url, endpoint_id=endpoint_id, api_key=api_key, verify_tls=verify_tls
    )
    client.upload_tar(container, _DETACH_DIR, {script_name: js})
    out = bytearray()
    err = bytearray()

    def _o(b: bytes) -> None:
        out.extend(b)

    def _e(b: bytes) -> None:
        err.extend(b)

    cmd = ["sh", "-c", _portainer_detach_cmd(script_path, log_path)]
    exec_id = client.create_exec(container, cmd, tty=False)
    client.start_exec_stream(exec_id, on_stdout=_o, on_stderr=_e, tty=False)
    blob = bytes(out) + bytes(err)
    if blob:
        sys.stdout.buffer.write(blob)
        sys.stdout.buffer.flush()
    return client.inspect_exec_exit_code(exec_id), log_path


def _detach_via_ssh(
    n: int, container: str, js: bytes, run_id: str, *, dev: bool = False
) -> tuple[int, str]:
    """ssh-путь: залить скрипт через stdin, запустить `docker exec -d` (detached)."""
    ip, user, key = _ssh_conn(n, dev=dev)
    script_path, log_path = detach_script_paths(run_id)
    put = f"docker exec -i {container} sh -c {shlex.quote(f'cat > {script_path}')}"
    up = subprocess.run(["ssh", "-i", key, f"{user}@{ip}", put], input=js, check=False)
    if up.returncode != 0:
        return up.returncode, log_path
    # `docker exec -d` возвращается сразу; процесс живёт в контейнере независимо от ssh.
    run = (
        f"docker exec -d {container} sh -c "
        f"{shlex.quote(f'node {script_path} > {log_path} 2>&1 < /dev/null')}"
    )
    res = subprocess.run(["ssh", "-i", key, f"{user}@{ip}", run], check=False)
    return res.returncode, log_path


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
