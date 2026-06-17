"""Тесты `mpu mp-init` (mpu.commands.mp_init) — оркестрация подъёма core-стека."""

import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import mp_init as cmd
from mpu.lib import dt_host, mp_stack

runner = CliRunner()


def _no_missing() -> list[str]:
    return []


def _net_present(name: str) -> bool:
    return True


def _setup_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Каталог есть, сеть есть, образы на месте — путь к подъёму стеков открыт."""
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: tmp_path)
    monkeypatch.setattr(mp_stack, "network_exists", _net_present)
    monkeypatch.setattr(mp_stack, "missing_images", _no_missing)


def _ok_run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
    return subprocess.CompletedProcess[bytes](args=argv, returncode=0)


def _boom(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
    raise AssertionError("subprocess.run не должен вызываться в этом сценарии")


def test_dir_missing_aborts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = tmp_path / "nope"
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: missing)
    res = runner.invoke(cmd.app, [])
    assert res.exit_code == 2
    assert "каталог mp-config-local не найден" in res.output


def test_dry_run_iterates_all_stacks_without_exec(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup_ok(tmp_path, monkeypatch)
    built: list[str] = []

    def _build(stack: mp_stack.Stack, base: Path) -> list[str]:
        built.append(stack.name)
        return ["docker", "compose", "up"]

    monkeypatch.setattr(mp_stack, "build_up_argv", _build)
    monkeypatch.setattr(subprocess, "run", _boom)

    res = runner.invoke(cmd.app, ["--dry-run"])
    assert res.exit_code == 0, res.output
    assert built == ["mp-nats", "sl-0", "sl-1", "mp-nginx", "dt-host"]
    assert "dry-run: ничего не выполнено" in res.output


def test_real_run_executes_all_in_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup_ok(tmp_path, monkeypatch)
    calls: list[list[str]] = []
    cwds: list[object] = []

    def _run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(argv)
        cwds.append(kwargs.get("cwd"))
        return subprocess.CompletedProcess[bytes](args=argv, returncode=0)

    monkeypatch.setattr(subprocess, "run", _run)
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert len(calls) == 5  # 5 core-стеков
    for argv in calls:
        assert argv[-3:] == ["up", "-d", "--force-recreate"]
    assert all(c == tmp_path for c in cwds)  # запуск в каталоге mp-config-local
    assert "mp-init: core поднят" in res.output


def test_fail_fast_stops_on_first_nonzero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup_ok(tmp_path, monkeypatch)
    calls: list[list[str]] = []

    def _run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(argv)
        rc = 0 if len(calls) == 1 else 7  # упасть на втором стеке (sl-0)
        return subprocess.CompletedProcess[bytes](args=argv, returncode=rc)

    monkeypatch.setattr(subprocess, "run", _run)
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 7
    assert len(calls) == 2  # остановились после упавшего; sl-1/nginx/dt-host не трогали
    assert "'sl-0' упал (rc=7)" in res.output


def test_missing_image_aborts_with_hint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: tmp_path)
    monkeypatch.setattr(mp_stack, "network_exists", _net_present)

    def _missing() -> list[str]:
        return ["mp-back:local"]

    monkeypatch.setattr(mp_stack, "missing_images", _missing)
    monkeypatch.setattr(subprocess, "run", _boom)  # до up дойти не должно

    res = runner.invoke(cmd.app, [])
    assert res.exit_code == 1
    assert "mp-back:local → sl-build-image" in res.output


def test_creates_network_when_absent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: tmp_path)
    monkeypatch.setattr(mp_stack, "missing_images", _no_missing)

    def _net_absent(name: str) -> bool:
        return False

    monkeypatch.setattr(mp_stack, "network_exists", _net_absent)

    created: list[tuple[str, str]] = []

    def _create(name: str, subnet: str) -> int:
        created.append((name, subnet))
        return 0

    monkeypatch.setattr(mp_stack, "create_network", _create)
    monkeypatch.setattr(subprocess, "run", _ok_run)

    res = runner.invoke(cmd.app, [])
    assert res.exit_code == 0, res.output
    assert created == [("mp-shared-net", "178.20.0.0/16")]
