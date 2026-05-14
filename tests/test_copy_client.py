"""Тесты `mpu copy-client` (mpu.commands.copy_client)."""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import copy_client as cmd
from mpu.lib import dt_host, servers
from mpu.lib.resolver import ResolveError

runner = CliRunner()


@pytest.fixture
def fake_resolve(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, object]]:
    """Patch resolve_server → server=2, single client_id=54 candidate."""
    state: dict[str, object] = {"selector": None}

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        state["selector"] = value
        return 2, [
            {
                "client_id": 54,
                "server": "sl-2",
                "title": "Acme",
                "spreadsheet_id": "ssAcme",
                "server_number": 2,
            }
        ]

    monkeypatch.setattr(cmd, "resolve_server", _resolve)

    def _pg_ip(n: int) -> str | None:
        return "192.168.150.32" if n == 2 else None

    monkeypatch.setattr(servers, "pg_ip", _pg_ip)
    yield state


@pytest.fixture
def fake_exec(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    captured: dict[str, object] = {}

    def _exec(inner: str, *, command_name: str) -> int:
        captured["inner"] = inner
        captured["command_name"] = command_name
        return 0

    monkeypatch.setattr(dt_host, "exec_cli", _exec)
    return captured


def test_happy_path(fake_resolve: dict[str, object], fake_exec: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    inner = fake_exec["inner"]
    assert isinstance(inner, str)
    assert "SOURCE_HOST=192.168.150.32" in inner
    assert "SOURCE_PORT=5432" in inner
    assert "TARGET_HOST=127.0.0.1" in inner
    assert "TARGET_PORT=5441" in inner
    assert "USE_NATS_PROXY=false" in inner
    assert "node ./src/clientsTransfer.js copy" in inner
    assert "--client-id 54" in inner
    assert "--source sl-2" in inner
    assert "--target sl-1" in inner
    assert "--skip INIT CREATE_TARGET_SCHEMA VERIFY_CLIENT_SCHEMA" in inner
    assert fake_exec["command_name"] == "mpu copy-client"


def test_resolve_error_bubbles_up(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise ResolveError("nothing matched: 'missing'", candidates=[])

    monkeypatch.setattr(cmd, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["missing"])

    assert res.exit_code == 2
    assert "mpu copy-client: nothing matched" in res.output


def test_ambiguous_client_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 2, [
            {"client_id": 54, "server": "sl-2", "server_number": 2},
            {"client_id": 55, "server": "sl-2", "server_number": 2},
        ]

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 2
    assert "matches 2 clients" in res.output


def test_no_pg_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 7, [{"client_id": 99, "server": "sl-7", "server_number": 7}]

    def _pg_ip(n: int) -> str | None:
        return None

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    monkeypatch.setattr(servers, "pg_ip", _pg_ip)
    res = runner.invoke(cmd.app, ["99"])

    assert res.exit_code == 2
    assert "pg_7 not found" in res.output


def test_sl_selector_without_client_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """`mpu copy-client sl-2` — резолвится в сервер без клиента → ошибка."""

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 2, []

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    res = runner.invoke(cmd.app, ["sl-2"])

    assert res.exit_code == 2
    assert "does not point to a specific client" in res.output
