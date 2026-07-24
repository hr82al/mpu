"""Тесты `mpu.lib.dt_host` — helper для запуска команд в локальном dt-host cli."""

from pathlib import Path

import click
import pytest

from mpu.lib import dt_host


def test_build_compose_argv_uses_default_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(dt_host.ENV_DIR, raising=False)
    argv = dt_host.build_compose_argv("echo hi")

    assert argv[:2] == ["docker", "compose"]
    # последние 5 элементов: exec -i[t] cli sh -c <inner> (флаг зависит от isatty())
    assert argv[-6] == "exec"
    assert argv[-5] in ("-i", "-it")
    assert argv[-4:-1] == ["cli", "sh", "-c"]
    assert argv[-1] == "echo hi"
    assert "--env-file" in argv
    assert any(arg.endswith("compose.sl-dt-host.yaml") for arg in argv)


def test_build_compose_argv_exec_flag_follows_isatty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без реального TTY на stdin (агент/CI) — `-i`, не `-it` (иначе docker виснет)."""
    monkeypatch.setattr(dt_host.sys.stdin, "isatty", lambda: False)
    argv = dt_host.build_compose_argv("echo hi")
    assert argv[argv.index("exec") + 1] == "-i"

    monkeypatch.setattr(dt_host.sys.stdin, "isatty", lambda: True)
    argv = dt_host.build_compose_argv("echo hi")
    assert argv[argv.index("exec") + 1] == "-it"


def test_build_compose_argv_env_layer_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Имена env-слоёв должны совпадать с mp-config-local, иначе docker падает на missing file.

    Регрессия: после переименования `.sl-dt.env` → `.sl-dt.base.env` команда падала
    «couldn't find env file». Проверяем имена, а не просто наличие `--env-file`.
    """
    monkeypatch.setenv(dt_host.ENV_DIR, str(tmp_path))
    (tmp_path / ".sl-dt.base.env").write_text("")
    (tmp_path / ".env").write_text("")  # опциональные слои присутствуют → включаются

    argv = dt_host.build_compose_argv("X")
    names = [Path(argv[i + 1]).name for i, a in enumerate(argv) if a == "--env-file"]
    assert names == [".sl-base.env", ".env", ".sl-dt.base.env"]  # .sl-dt.env отсутствует → пропущен


def test_build_compose_argv_respects_env_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(dt_host.ENV_DIR, str(tmp_path))
    argv = dt_host.build_compose_argv("X")

    # Все файлы должны быть под tmp_path.
    file_args = [a for a in argv if a.endswith((".env", ".yaml"))]
    assert file_args, "expected at least one file path in argv"
    for f in file_args:
        assert f.startswith(str(tmp_path)), f


def test_exec_cli_fails_when_compose_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # tmp_path существует, но compose.sl-dt-host.yaml — нет.
    monkeypatch.setenv(dt_host.ENV_DIR, str(tmp_path))
    with pytest.raises(click.exceptions.Exit) as excinfo:
        dt_host.exec_cli("echo hi", command_name="mpu-test")
    assert excinfo.value.exit_code == 2


def test_exec_cli_fails_when_dir_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = tmp_path / "nope"
    monkeypatch.setenv(dt_host.ENV_DIR, str(missing))
    with pytest.raises(click.exceptions.Exit) as excinfo:
        dt_host.exec_cli("echo hi", command_name="mpu-test")
    assert excinfo.value.exit_code == 2
