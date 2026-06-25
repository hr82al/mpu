"""Тесты `mpu make-schema` — exec-путь (subprocess) + client-id override.

snapshot `--print` дефолтов покрыт в test_commands_snapshot.py; здесь — НЕпокрытое:
локальный `docker exec`-вызов через `subprocess.run` (happy + ненулевой rc) и
переопределение client_id/контейнера. Контейнер по умолчанию sl-1 (как fish-функция).
"""

import subprocess
from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import make_schema
from mpu.lib import cli_wrap, servers

runner = CliRunner()

CANDIDATE: dict[str, object] = {
    "client_id": 2190,
    "spreadsheet_id": "1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c",
    "server": "sl-2",
    "title": "MODERNICA",
}


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def _fake_resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        if server_override:
            n = servers.server_number(server_override)
            assert n is not None, f"bad --server in test: {server_override!r}"
            return n, [CANDIDATE]
        sn = servers.server_number(value)
        if sn is not None:
            return sn, [CANDIDATE]
        return 2, [CANDIDATE]

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    monkeypatch.setattr(make_schema, "copy_to_clipboard", _noop_copy)
    yield


def test_make_schema_exec_runs_subprocess(fake_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Без --print → локальный `docker exec mp-sl-1-cli ...` через subprocess.run."""
    _ = fake_env
    captured: list[list[str]] = []

    def _fake_run(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
        _ = check
        captured.append(cmd)
        return subprocess.CompletedProcess[str](args=cmd, returncode=0)

    monkeypatch.setattr(make_schema.subprocess, "run", _fake_run)
    result = runner.invoke(make_schema.app, ["MODERNICA"])
    assert result.exit_code == 0, result.output
    assert captured == [
        [
            "docker",
            "exec",
            "mp-sl-1-cli",
            "node",
            "cli",
            "service:clientsMigrations",
            "init",
            "--client-id",
            "2190",
            "--server",
            "sl-1",
        ]
    ]


def test_make_schema_exec_nonzero_propagates_exit(
    fake_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ненулевой rc subprocess'а → typer.Exit(code=rc)."""
    _ = fake_env

    def _fake_run(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
        _ = check
        return subprocess.CompletedProcess[str](args=cmd, returncode=7)

    monkeypatch.setattr(make_schema.subprocess, "run", _fake_run)
    result = runner.invoke(make_schema.app, ["MODERNICA"])
    assert result.exit_code == 7


def test_make_schema_exec_server_override_container(
    fake_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--server sl-2 → контейнер mp-sl-2-cli и `--server sl-2`."""
    _ = fake_env
    captured: list[list[str]] = []

    def _fake_run(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
        _ = check
        captured.append(cmd)
        return subprocess.CompletedProcess[str](args=cmd, returncode=0)

    monkeypatch.setattr(make_schema.subprocess, "run", _fake_run)
    result = runner.invoke(make_schema.app, ["MODERNICA", "--server", "sl-2"])
    assert result.exit_code == 0, result.output
    assert captured[0][2] == "mp-sl-2-cli"
    assert captured[0][-2:] == ["--server", "sl-2"]


def test_make_schema_print_client_id_override(fake_env: None) -> None:
    """--print + явный --client-id перекрывает авто-резолв (контейнер всё ещё sl-1)."""
    _ = fake_env
    result = runner.invoke(make_schema.app, ["MODERNICA", "--client-id", "555", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        "docker exec mp-sl-1-cli node cli service:clientsMigrations init "
        "--client-id 555 --server sl-1"
    )
