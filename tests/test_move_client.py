"""Тесты `mpu move-client` (mpu.commands.move_client)."""

from collections.abc import Iterator
from typing import cast

import pytest
from typer.testing import CliRunner

from mpu.commands import move_client as cmd
from mpu.lib import pssh
from mpu.lib.resolver import ResolveError

runner = CliRunner()


@pytest.fixture
def fake_resolve(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, object]]:
    state: dict[str, object] = {"selector": None}

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        state["selector"] = value
        return 13, [
            {
                "client_id": 1589,
                "server": "sl-13",
                "title": "Acme",
                "spreadsheet_id": "ssAcme",
                "server_number": 13,
            }
        ]

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    yield state


@pytest.fixture
def fake_run(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    captured: dict[str, object] = {}

    def _run(*, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        _ = stdin
        captured["cmd"] = cmd
        captured["container"] = container
        return 0

    monkeypatch.setattr(pssh, "pssh_run_container", _run)
    return captured


def test_happy_path_default_target_sl_1(
    fake_resolve: dict[str, object], fake_run: dict[str, object]
) -> None:
    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 0, res.output
    cmd_argv = fake_run["cmd"]
    assert cmd_argv == [
        "node",
        "cli",
        "service:clientsTransfer",
        "createJob",
        "--source",
        "sl-13",
        "--target",
        "sl-1",
        "--client-id",
        "1589",
        "--destroy",
    ]
    assert fake_run["container"] == "mp-dt-cli"


def test_custom_target(fake_resolve: dict[str, object], fake_run: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, ["1589", "--target", "sl-5"])

    assert res.exit_code == 0, res.output
    cmd_argv = cast(list[str], fake_run["cmd"])
    assert "--target" in cmd_argv
    target_idx = cmd_argv.index("--target")
    assert cmd_argv[target_idx + 1] == "sl-5"


def test_bad_target_format(fake_resolve: dict[str, object], fake_run: dict[str, object]) -> None:
    _ = fake_run
    res = runner.invoke(cmd.app, ["1589", "--target", "xx-5"])

    assert res.exit_code == 2
    assert "bad --target" in res.output


def test_source_equals_target_aborts(
    fake_resolve: dict[str, object], fake_run: dict[str, object]
) -> None:
    _ = fake_run
    # fake_resolve возвращает sl-13; ставим target=sl-13 → должен отказать
    res = runner.invoke(cmd.app, ["1589", "--target", "sl-13"])

    assert res.exit_code == 2
    assert "оба sl-13" in res.output


def test_resolve_error(monkeypatch: pytest.MonkeyPatch, fake_run: dict[str, object]) -> None:
    _ = fake_run

    def _raise(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise ResolveError("nothing matched: 'missing'", candidates=[])

    monkeypatch.setattr(cmd, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["missing"])

    assert res.exit_code == 2
    assert "mpu move-client: nothing matched" in res.output


def test_ambiguous_client_ids(monkeypatch: pytest.MonkeyPatch, fake_run: dict[str, object]) -> None:
    _ = fake_run

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 13, [
            {"client_id": 1589, "server": "sl-13", "server_number": 13},
            {"client_id": 1590, "server": "sl-13", "server_number": 13},
        ]

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "matches 2 clients" in res.output


def test_sl_selector_without_client_id(
    monkeypatch: pytest.MonkeyPatch, fake_run: dict[str, object]
) -> None:
    _ = fake_run

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 13, []

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["sl-13"])

    assert res.exit_code == 2
    assert "does not point to a specific client" in res.output


def test_run_failure_propagates(
    fake_resolve: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    def _run(*, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        _ = container, cmd, stdin
        return 17

    monkeypatch.setattr(pssh, "pssh_run_container", _run)
    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 17
