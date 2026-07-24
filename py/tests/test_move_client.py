"""Тесты `mpu move-client` (mpu.commands.move_client)."""

from collections.abc import Callable, Iterator
from typing import cast

import pytest
from typer.testing import CliRunner

from conftest import ContainerRunRecorder
from mpu.commands import move_client as cmd
from mpu.lib import pssh, resolver
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

    monkeypatch.setattr(resolver, "resolve_server", _resolve)
    yield state


@pytest.fixture
def fake_run(container_run: Callable[..., ContainerRunRecorder]) -> ContainerRunRecorder:
    return container_run(pssh)


@pytest.fixture
def fake_record(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, str, str]]:
    recorded: list[tuple[int, str, str]] = []

    def _record(client_id: int, source: str, target: str, *, now: int | None = None) -> None:
        _ = now
        recorded.append((client_id, source, target))

    monkeypatch.setattr(cmd, "record_move", _record)
    return recorded


def test_happy_path_default_target_sl_1(
    fake_resolve: dict[str, object],
    fake_run: ContainerRunRecorder,
    fake_record: list[tuple[int, str, str]],
) -> None:
    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 0, res.output
    cmd_argv = fake_run.calls[0]["cmd"]
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
    assert fake_run.calls[0]["container"] == "mp-dt-cli"
    assert fake_record == [(1589, "sl-13", "sl-1")]


def test_custom_target(
    fake_resolve: dict[str, object],
    fake_run: ContainerRunRecorder,
    fake_record: list[tuple[int, str, str]],
) -> None:
    res = runner.invoke(cmd.app, ["1589", "--target", "sl-5"])

    assert res.exit_code == 0, res.output
    cmd_argv = cast(list[str], fake_run.calls[0]["cmd"])
    assert "--target" in cmd_argv
    target_idx = cmd_argv.index("--target")
    assert cmd_argv[target_idx + 1] == "sl-5"
    assert fake_record == [(1589, "sl-13", "sl-5")]


def test_bad_target_format(fake_resolve: dict[str, object], fake_run: ContainerRunRecorder) -> None:
    _ = fake_run
    res = runner.invoke(cmd.app, ["1589", "--target", "xx-5"])

    assert res.exit_code == 2
    assert "bad --target" in res.output


def test_source_equals_target_aborts(
    fake_resolve: dict[str, object], fake_run: ContainerRunRecorder
) -> None:
    _ = fake_run
    # fake_resolve возвращает sl-13; ставим target=sl-13 → должен отказать
    res = runner.invoke(cmd.app, ["1589", "--target", "sl-13"])

    assert res.exit_code == 2
    assert "оба sl-13" in res.output


def test_resolve_error(monkeypatch: pytest.MonkeyPatch, fake_run: ContainerRunRecorder) -> None:
    _ = fake_run

    def _raise(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise ResolveError("nothing matched: 'missing'", candidates=[])

    monkeypatch.setattr(resolver, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["missing"])

    assert res.exit_code == 2
    assert "mpu move-client: nothing matched" in res.output


def test_ambiguous_client_ids(
    monkeypatch: pytest.MonkeyPatch, fake_run: ContainerRunRecorder
) -> None:
    _ = fake_run

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 13, [
            {"client_id": 1589, "server": "sl-13", "server_number": 13},
            {"client_id": 1590, "server": "sl-13", "server_number": 13},
        ]

    monkeypatch.setattr(resolver, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "matches 2 clients" in res.output


def test_sl_selector_without_client_id(
    monkeypatch: pytest.MonkeyPatch, fake_run: ContainerRunRecorder
) -> None:
    _ = fake_run

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 13, []

    monkeypatch.setattr(resolver, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["sl-13"])

    assert res.exit_code == 2
    assert "does not point to a specific client" in res.output


def test_run_failure_propagates(
    fake_resolve: dict[str, object],
    fake_record: list[tuple[int, str, str]],
    container_run: Callable[..., ContainerRunRecorder],
) -> None:
    container_run(pssh, rc=17)
    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 17
    assert fake_record == []  # запись хода только при rc == 0
