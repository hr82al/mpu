"""Тесты `mpu/lib/pssh.py` и `mpu/commands/pssh.py`."""
# pyright: reportPrivateUsage=false

from collections.abc import Iterator
from pathlib import Path
from typing import ClassVar

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import pssh as pssh_cmd
from mpu.lib import containers, portainer, pssh, servers, store


def _isolate_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Подменить SQLite-путь на пустой tmp файл — иначе тесты читают prod ~/.config/mpu/mpu.db."""
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")


@pytest.fixture
def env_ssh_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "PG_MY_USER_NAME=alice\nsl_1='192.168.150.91'\nsl_2='192.168.150.92'\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    _isolate_db(tmp_path, monkeypatch)
    servers.reset_cache()
    yield p
    servers.reset_cache()


@pytest.fixture
def env_portainer_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "PORTAINER_API_KEY=ptr_test\n"
        "sl_11_portainer=https://192.168.150.12:9443/19\n"
        "sl_12_portainer=https://192.168.150.12:9443/19\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    _isolate_db(tmp_path, monkeypatch)
    servers.reset_cache()
    yield p
    servers.reset_cache()


@pytest.fixture
def env_mixed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "PG_MY_USER_NAME=alice\n"
        "PORTAINER_API_KEY=ptr_test\n"
        "sl_1='192.168.150.91'\n"
        "sl_11_portainer=https://192.168.150.12:9443/19\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    _isolate_db(tmp_path, monkeypatch)
    servers.reset_cache()
    yield p
    servers.reset_cache()


# ---------- _resolve_transport ----------


def test_resolve_ssh_when_only_ssh(env_ssh_only: Path) -> None:
    _ = env_ssh_only
    assert pssh._resolve_transport(1, None) == "ssh"


def test_resolve_portainer_when_only_portainer(env_portainer_only: Path) -> None:
    _ = env_portainer_only
    assert pssh._resolve_transport(11, None) == "portainer"


def test_resolve_prefers_portainer_when_both(
    env_mixed: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Если для одного сервера задан и ssh, и portainer — приоритет у Portainer."""
    p = env_mixed
    p.write_text(
        p.read_text(encoding="utf-8") + "sl_1_portainer=https://x:9443/19\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    servers.reset_cache()
    assert pssh._resolve_transport(1, None) == "portainer"


def test_resolve_via_override(env_mixed: Path) -> None:
    _ = env_mixed
    assert pssh._resolve_transport(1, "portainer") == "portainer"
    assert pssh._resolve_transport(11, "ssh") == "ssh"


def test_resolve_via_invalid(env_ssh_only: Path) -> None:
    _ = env_ssh_only
    with pytest.raises(typer.Exit):
        pssh._resolve_transport(1, "telnet")


def test_resolve_no_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / ".env"
    p.write_text("", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", p)
    servers.reset_cache()
    with pytest.raises(typer.Exit) as ei:
        pssh._resolve_transport(99, None)
    assert ei.value.exit_code == 2


# ---------- _run_via_ssh ----------


def test_run_via_ssh_builds_correct_command(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    class _Result:
        returncode = 7

    def _fake_run(args: list[str], **kw: object) -> _Result:
        captured["args"] = args
        captured["kw"] = kw
        return _Result()

    monkeypatch.setattr(pssh.subprocess, "run", _fake_run)
    rc = pssh._run_via_ssh(1, ["ls", "-la", "/app"], stdin=b"data")
    assert rc == 7
    args = captured["args"]
    assert isinstance(args, list)
    assert args[:2] == ["bash", "-c"]
    full_str: str = args[2]  # pyright: ignore[reportUnknownVariableType]
    assert isinstance(full_str, str)
    # ssh без -t (TTY) и docker exec -i (а не -it) — иначе stdin не уйдёт как pipe.
    assert "ssh -i " in full_str
    assert "ssh -it" not in full_str
    assert "docker exec -i mp-sl-1-cli sh -c " in full_str
    assert "docker exec -it" not in full_str
    # Команда квотируется через shlex.
    assert "ls -la /app" in full_str
    kw = captured["kw"]
    assert isinstance(kw, dict)
    assert kw["input"] == b"data"


# ---------- _run_via_portainer ----------


class _StubClient:
    """Подменяет portainer.Client; запоминает все вызовы."""

    instances: ClassVar[list["_StubClient"]] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.uploads: list[tuple[str, str, dict[str, bytes]]] = []
        self.execs: list[list[str]] = []
        self.exec_containers: list[str] = []
        self.starts: list[str] = []
        self.exit_code = 0
        self.stdout_to_emit = b""
        self.stderr_to_emit = b""
        _StubClient.instances.append(self)

    def upload_tar(self, container: str, dest: str, files: dict[str, bytes]) -> None:
        self.uploads.append((container, dest, files))

    def create_exec(self, container: str, cmd: list[str], *, tty: bool = False) -> str:
        _ = tty
        self.exec_containers.append(container)
        self.execs.append(list(cmd))
        return f"exec-{len(self.execs)}"

    def start_exec_stream(
        self,
        exec_id: str,
        *,
        on_stdout: object,
        on_stderr: object,
        tty: bool = False,
    ) -> None:
        _ = tty
        self.starts.append(exec_id)
        if self.stdout_to_emit:
            on_stdout(self.stdout_to_emit)  # type: ignore[operator]
        if self.stderr_to_emit:
            on_stderr(self.stderr_to_emit)  # type: ignore[operator]

    def inspect_exec_exit_code(self, exec_id: str) -> int:
        _ = exec_id
        return self.exit_code


@pytest.fixture
def stub_portainer(monkeypatch: pytest.MonkeyPatch) -> type[_StubClient]:
    _StubClient.instances.clear()
    monkeypatch.setattr(portainer, "Client", _StubClient)
    monkeypatch.setattr(pssh.portainer, "Client", _StubClient)
    return _StubClient


def test_run_via_portainer_no_stdin(
    env_portainer_only: Path, stub_portainer: type[_StubClient]
) -> None:
    _ = env_portainer_only
    rc = pssh._run_via_portainer(11, ["ls", "/app"], stdin=b"")
    assert rc == 0
    assert len(stub_portainer.instances) == 1
    c = stub_portainer.instances[0]
    assert c.kwargs["base_url"] == "https://192.168.150.12:9443"
    assert c.kwargs["endpoint_id"] == 19
    assert c.kwargs["api_key"] == "ptr_test"
    assert c.kwargs["verify_tls"] is False
    # Без stdin upload'а нет. Команда обёрнута в shell-prelude, пишущий PID в файл
    # (для Ctrl+C → kill remote). Второй exec — финальный rm -f pidfile.
    assert c.uploads == []
    assert c.execs[0][0:2] == ["sh", "-c"]
    wrapped = c.execs[0][2]
    assert "echo $$ > /tmp/__MPU_PSSH_PID" in wrapped
    assert "exec ls /app" in wrapped  # `exec` сразу команду, без промежуточного sh -c
    assert c.execs[1] == ["rm", "-f", "/tmp/__MPU_PSSH_PID"]


def test_run_via_portainer_with_stdin_uploads_and_wraps(
    env_portainer_only: Path, stub_portainer: type[_StubClient]
) -> None:
    _ = env_portainer_only
    rc = pssh._run_via_portainer(11, ["node", "--input-type=module", "-"], stdin=b"console.log(1)")
    assert rc == 0
    c = stub_portainer.instances[0]
    # Upload tarred stdin в /tmp.
    assert c.uploads == [("mp-sl-11-cli", "/tmp", {"__MPU_PSSH_STDIN": b"console.log(1)"})]
    # Команда обёрнута: shell-prelude пишет PID в файл, exec'ит inner с командой
    # и редиректом stdin из /tmp/__MPU_PSSH_STDIN.
    assert c.execs[0][0:2] == ["sh", "-c"]
    wrapped = c.execs[0][2]
    assert "echo $$ > /tmp/__MPU_PSSH_PID" in wrapped
    assert "exec node" in wrapped and "--input-type=module" in wrapped
    assert "< /tmp/__MPU_PSSH_STDIN" in wrapped
    # Второй exec — финальный cleanup: pidfile + stdin tar.
    assert c.execs[1] == ["rm", "-f", "/tmp/__MPU_PSSH_PID", "/tmp/__MPU_PSSH_STDIN"]


def test_run_via_portainer_propagates_exit_code(
    env_portainer_only: Path, stub_portainer: type[_StubClient]
) -> None:
    _ = env_portainer_only
    # Hook через monkeypatch на инстанс — установим exit_code до вызова.
    original_init = _StubClient.__init__

    def _patched_init(self: _StubClient, **kw: object) -> None:
        original_init(self, **kw)
        self.exit_code = 42

    _StubClient.__init__ = _patched_init  # type: ignore[method-assign]
    try:
        rc = pssh._run_via_portainer(11, ["false"], stdin=b"")
        assert rc == 42
    finally:
        _StubClient.__init__ = original_init  # type: ignore[method-assign]


def test_run_via_portainer_verify_tls_env(
    env_portainer_only: Path,
    stub_portainer: type[_StubClient],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    p = env_portainer_only
    p.write_text(p.read_text() + "PORTAINER_VERIFY_TLS=true\n", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", p)
    servers.reset_cache()
    pssh._run_via_portainer(11, ["ls"], stdin=b"")
    assert stub_portainer.instances[0].kwargs["verify_tls"] is True


# ---------- mpup-ssh CLI ----------


def test_pssh_cli_dispatches_to_pssh_run(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(
        *,
        server_number: int,
        cmd: list[str],
        stdin: bytes = b"",
        via: str | None = None,
    ) -> int:
        captured.update(server_number=server_number, cmd=list(cmd), stdin=stdin, via=via)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--", "ls", "-la", "/app"])
    assert result.exit_code == 0, result.output
    assert captured["server_number"] == 1
    assert captured["cmd"] == ["ls", "-la", "/app"]
    assert captured["via"] is None


def test_pssh_cli_via_override(env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, via: str | None, **kw: object) -> int:
        captured["via"] = via
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--via", "portainer", "--", "echo", "hi"])
    assert result.exit_code == 0
    assert captured["via"] == "portainer"


def test_pssh_cli_empty_command_rejected(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        raise AssertionError("должно упасть до вызова")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1"])
    assert result.exit_code == 2
    assert "пустая команда" in result.output


def test_pssh_cli_propagates_exit_code(env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        return 13

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--", "false"])
    assert result.exit_code == 13


def test_pssh_cli_rejects_sl_0(env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-0", "--", "ls"])
    assert result.exit_code == 2


# ---------- stdin sources ----------


def test_pssh_cli_stdin_pipe(env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, stdin: bytes, **kw: object) -> int:
        captured["stdin"] = stdin
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--", "cat"], input="hello\nworld")
    assert result.exit_code == 0
    assert captured["stdin"] == b"hello\nworld"


def test_pssh_cli_stdin_text(env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, stdin: bytes, **kw: object) -> int:
        captured["stdin"] = stdin
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--stdin-text", "console.log(1)", "--", "cat"])
    assert result.exit_code == 0, result.output
    assert captured["stdin"] == b"console.log(1)"


def test_pssh_cli_stdin_file(
    env_ssh_only: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    p = tmp_path / "data.txt"
    p.write_bytes(b"file content\n")
    captured: dict[str, object] = {}

    def _fake_run(*, stdin: bytes, **kw: object) -> int:
        captured["stdin"] = stdin
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--stdin-file", str(p), "--", "cat"])
    assert result.exit_code == 0, result.output
    assert captured["stdin"] == b"file content\n"


class _FakeStdin:
    """Минимальный shim под sys.stdin: isatty + buffer.read()."""

    def __init__(self, *, is_tty: bool, payload: bytes | None) -> None:
        self._is_tty = is_tty
        self._payload = payload

    def isatty(self) -> bool:
        return self._is_tty

    @property
    def buffer(self) -> "_FakeStdin":
        return self

    def read(self) -> bytes:
        if self._payload is None:
            pytest.fail("read() не должен вызываться")
        return self._payload


def test_resolve_stdin_tty_default_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    """TTY без явного --stdin-* → b"", не блокируемся на read()."""
    monkeypatch.setattr(pssh_cmd.sys, "stdin", _FakeStdin(is_tty=True, payload=None))
    out = pssh_cmd._resolve_stdin(stdin_text=None, stdin_file=None, stdin_tty=False)
    assert out == b""


def test_resolve_stdin_tty_explicit_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    """--stdin-tty при TTY → читаем до EOF, печатаем подсказку в stderr."""
    monkeypatch.setattr(pssh_cmd.sys, "stdin", _FakeStdin(is_tty=True, payload=b"typed input"))
    out = pssh_cmd._resolve_stdin(stdin_text=None, stdin_file=None, stdin_tty=True)
    assert out == b"typed input"


def test_resolve_stdin_pipe_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    """stdin не TTY (pipe) → forward'им содержимое."""
    monkeypatch.setattr(pssh_cmd.sys, "stdin", _FakeStdin(is_tty=False, payload=b"piped"))
    out = pssh_cmd._resolve_stdin(stdin_text=None, stdin_file=None, stdin_tty=False)
    assert out == b"piped"


def test_pssh_cli_stdin_text_and_file_mutex(
    env_ssh_only: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    p = tmp_path / "x.txt"
    p.write_bytes(b"x")

    def _fake_run(**_kw: object) -> int:
        raise AssertionError("должно упасть до вызова")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(
        pssh_cmd.app,
        ["sl-1", "--stdin-text", "x", "--stdin-file", str(p), "--", "cat"],
    )
    assert result.exit_code == 2
    assert "взаимоисключающи" in result.output


def test_pssh_cli_stdin_tty_and_text_mutex(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        raise AssertionError("должно упасть до вызова")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--stdin-tty", "--stdin-text", "x", "--", "cat"])
    assert result.exit_code == 2
    assert "взаимоисключающи" in result.output


# ---------- mpup-ssh CLI: container-name dispatch ----------


def _seed_container(
    bootstrap_db: "object",
    *,
    url: str,
    endpoint_id: int,
    endpoint_name: str,
    container_name: str,
    container_id: str = "ctr-1",
) -> None:
    # bootstrap_db — Callable[[Path | str], None] из conftest.py; используем object для краткости
    bootstrap_db(store.DB_PATH)  # type: ignore[operator]
    with store.store() as conn:
        conn.execute(
            "INSERT INTO portainer_containers "
            "(portainer_url, endpoint_id, endpoint_name, container_id, container_name, "
            " server_number, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (url, endpoint_id, endpoint_name, container_id, container_name, None, 100),
        )
        conn.commit()


def test_pssh_cli_dispatches_to_container_path(
    env_portainer_only: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`mpup-ssh mp-dt-cli -- ls` → pssh_run_container с этим именем (не pssh_run)."""
    _ = env_portainer_only
    _seed_container(
        bootstrap_db,
        url="https://p:9443",
        endpoint_id=12,
        endpoint_name="mp-dt",
        container_name="mp-dt-cli",
    )
    captured: dict[str, object] = {}

    def _fake_run_container(*, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        captured.update(container=container, cmd=list(cmd), stdin=stdin)
        return 0

    def _fake_pssh_run(**_kw: object) -> int:
        raise AssertionError("для имени контейнера должен вызваться pssh_run_container")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run_container", _fake_run_container)
    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_pssh_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["mp-dt-cli", "--", "ls", "/app"])
    assert result.exit_code == 0, result.output
    assert captured["container"] == "mp-dt-cli"
    assert captured["cmd"] == ["ls", "/app"]


def test_pssh_cli_container_ambiguous_prints_candidates(
    env_portainer_only: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Одинаковое имя на нескольких endpoint'ах → exit 2 + список вариантов."""
    _ = env_portainer_only
    _seed_container(
        bootstrap_db,
        url="https://p:9443",
        endpoint_id=12,
        endpoint_name="mp-dt",
        container_name="cli",
        container_id="c1",
    )
    _seed_container(
        bootstrap_db,
        url="https://p:9443",
        endpoint_id=14,
        endpoint_name="wb-positions-parser",
        container_name="cli",
        container_id="c2",
    )

    def _no_call(**_kw: object) -> int:
        raise AssertionError("на ambiguous контейнер не должно быть вызова")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run_container", _no_call)
    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _no_call)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["cli", "--", "ls"])
    assert result.exit_code == 2
    assert "ambiguous" in result.output
    assert "endpoint=mp-dt" in result.output
    assert "endpoint=wb-positions-parser" in result.output


def test_pssh_cli_container_rejects_via_ssh(
    env_portainer_only: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`--via ssh` для имени контейнера → exit 2 (не поддерживается)."""
    _ = env_portainer_only
    _seed_container(
        bootstrap_db,
        url="https://p:9443",
        endpoint_id=12,
        endpoint_name="mp-dt",
        container_name="mp-dt-cli",
    )

    def _no_call(**_kw: object) -> int:
        raise AssertionError("не должно вызываться")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run_container", _no_call)
    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _no_call)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["mp-dt-cli", "--via", "ssh", "--", "ls"])
    assert result.exit_code == 2
    assert "--via ssh" in result.output


def test_pssh_cli_falls_through_to_mpu_search_when_container_not_found(
    env_ssh_only: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Незнакомое имя контейнера → mpu-search; sl-N path остаётся через pssh_run."""
    _ = env_ssh_only
    # Бутстрапим пустую таблицу portainer_containers — `unknown-name` там нет.
    bootstrap_db(store.DB_PATH)  # type: ignore[operator]

    def _fake_resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        assert value == "unknown-name"
        return 1, [{"client_id": 7, "server_number": 1, "server": "sl-1"}]

    captured: dict[str, object] = {}

    def _fake_run(*, server_number: int, cmd: list[str], **_kw: object) -> int:
        captured.update(server_number=server_number, cmd=list(cmd))
        return 0

    monkeypatch.setattr(pssh_cmd, "resolve_server", _fake_resolve)
    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["unknown-name", "--", "ls"])
    assert result.exit_code == 0, result.output
    assert captured["server_number"] == 1
    assert captured["cmd"] == ["ls"]


# ---------- lib/pssh.pssh_run_container ----------


def test_pssh_run_container_routes_to_portainer(
    env_portainer_only: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
    stub_portainer: type["_StubClient"],
) -> None:
    """pssh_run_container резолвит target из SQLite и шлёт exec через _StubClient."""
    _ = env_portainer_only
    _seed_container(
        bootstrap_db,
        url="https://192.168.150.12:9443",
        endpoint_id=12,
        endpoint_name="mp-dt",
        container_name="mp-dt-cli",
    )
    _ = monkeypatch
    rc = pssh.pssh_run_container(container="mp-dt-cli", cmd=["echo", "hi"])
    assert rc == 0
    c = stub_portainer.instances[0]
    assert c.kwargs["base_url"] == "https://192.168.150.12:9443"
    assert c.kwargs["endpoint_id"] == 12
    assert c.kwargs["api_key"] == "ptr_test"
    # Контейнер в exec — mp-dt-cli (не mp-sl-N-cli)
    assert all(ctr == "mp-dt-cli" for ctr in c.exec_containers)
    # cmd обёрнут shell-prelude'ом: `sh -c 'echo $$ > pidfile; exec echo hi'`
    wrapped = c.execs[0][2]
    assert "exec echo hi" in wrapped


def test_pssh_run_container_not_found_raises(
    env_portainer_only: Path,
    bootstrap_db: object,
) -> None:
    _ = env_portainer_only
    bootstrap_db(store.DB_PATH)  # type: ignore[operator]
    with pytest.raises(containers.ContainerResolveError):
        pssh.pssh_run_container(container="nope", cmd=["echo"])


def test_pssh_run_container_no_api_key(
    tmp_path: Path,
    bootstrap_db: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    try:
        _seed_container(
            bootstrap_db,
            url="https://p:9443",
            endpoint_id=12,
            endpoint_name="mp-dt",
            container_name="mp-dt-cli",
        )
        with pytest.raises(typer.Exit) as excinfo:
            pssh.pssh_run_container(container="mp-dt-cli", cmd=["echo"])
        assert excinfo.value.exit_code == 2
    finally:
        servers.reset_cache()
