"""Тесты `mpu/lib/pssh.py` и `mpu/commands/pssh.py`."""
# pyright: reportPrivateUsage=false

from collections.abc import Iterator
from pathlib import Path
from typing import ClassVar

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import pssh as pssh_cmd
from mpu.lib import portainer, pssh, servers, store


def _isolate_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Подменить SQLite-путь на пустой tmp файл — иначе тесты читают prod ~/.config/mpu/mpu.db."""
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")


@pytest.fixture
def env_ssh_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "PG_MY_USER_NAME=alice\n"
        "sl_1='192.168.150.91'\n"
        "sl_2='192.168.150.92'\n",
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
        self.starts: list[str] = []
        self.exit_code = 0
        self.stdout_to_emit = b""
        self.stderr_to_emit = b""
        _StubClient.instances.append(self)

    def upload_tar(
        self, container: str, dest: str, files: dict[str, bytes]
    ) -> None:
        self.uploads.append((container, dest, files))

    def create_exec(self, container: str, cmd: list[str]) -> str:
        _ = container
        self.execs.append(list(cmd))
        return f"exec-{len(self.execs)}"

    def start_exec_stream(
        self,
        exec_id: str,
        *,
        on_stdout: object,
        on_stderr: object,
    ) -> None:
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
    # Без stdin — никакого upload и cmd передаётся как есть.
    assert c.uploads == []
    assert c.execs == [["ls", "/app"]]


def test_run_via_portainer_with_stdin_uploads_and_wraps(
    env_portainer_only: Path, stub_portainer: type[_StubClient]
) -> None:
    _ = env_portainer_only
    rc = pssh._run_via_portainer(
        11, ["node", "--input-type=module", "-"], stdin=b"console.log(1)"
    )
    assert rc == 0
    c = stub_portainer.instances[0]
    # Upload tarred stdin в /tmp.
    assert c.uploads == [("mp-sl-11-cli", "/tmp", {"__MPU_PSSH_STDIN": b"console.log(1)"})]
    # Команда обёрнута в sh -c с редиректом из /tmp/__MPU_PSSH_STDIN.
    assert c.execs[0][0] == "sh"
    assert c.execs[0][1] == "-c"
    wrapped = c.execs[0][2]
    assert "node" in wrapped and "--input-type=module" in wrapped
    assert "< /tmp/__MPU_PSSH_STDIN" in wrapped
    # Второй exec — cleanup.
    assert c.execs[1] == ["rm", "-f", "/tmp/__MPU_PSSH_STDIN"]


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


# ---------- mpu-pssh CLI ----------


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
        captured.update(
            server_number=server_number, cmd=list(cmd), stdin=stdin, via=via
        )
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--", "ls", "-la", "/app"])
    assert result.exit_code == 0, result.output
    assert captured["server_number"] == 1
    assert captured["cmd"] == ["ls", "-la", "/app"]
    assert captured["via"] is None


def test_pssh_cli_via_override(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, via: str | None, **kw: object) -> int:
        captured["via"] = via
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(
        pssh_cmd.app, ["sl-1", "--via", "portainer", "--", "echo", "hi"]
    )
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


def test_pssh_cli_propagates_exit_code(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        return 13

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-1", "--", "false"])
    assert result.exit_code == 13


def test_pssh_cli_rejects_sl_0(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(pssh_cmd.app, ["sl-0", "--", "ls"])
    assert result.exit_code == 2


# ---------- stdin sources ----------


def test_pssh_cli_stdin_pipe(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
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


def test_pssh_cli_stdin_text(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, stdin: bytes, **kw: object) -> int:
        captured["stdin"] = stdin
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(
        pssh_cmd.app, ["sl-1", "--stdin-text", "console.log(1)", "--", "cat"]
    )
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
    result = runner.invoke(
        pssh_cmd.app, ["sl-1", "--stdin-file", str(p), "--", "cat"]
    )
    assert result.exit_code == 0, result.output
    assert captured["stdin"] == b"file content\n"


def test_pssh_cli_no_stdin(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only
    captured: dict[str, object] = {}

    def _fake_run(*, stdin: bytes, **kw: object) -> int:
        captured["stdin"] = stdin
        captured.update(kw)
        return 0

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    # --no-stdin → b"", даже если pipe-stdin есть.
    result = runner.invoke(
        pssh_cmd.app, ["sl-1", "--no-stdin", "--", "ls"], input="ignored"
    )
    assert result.exit_code == 0, result.output
    assert captured["stdin"] == b""


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


def test_pssh_cli_no_stdin_with_text_rejected(
    env_ssh_only: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_ssh_only

    def _fake_run(**_kw: object) -> int:
        raise AssertionError("должно упасть до вызова")

    monkeypatch.setattr(pssh_cmd._pssh, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(
        pssh_cmd.app, ["sl-1", "--no-stdin", "--stdin-text", "x", "--", "cat"]
    )
    assert result.exit_code == 2
