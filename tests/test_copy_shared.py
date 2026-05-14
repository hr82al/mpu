"""Тесты `mpu-copy-shared` (mpu.commands.copy_shared)."""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import copy_shared as cmd
from mpu.lib import dt_host, servers
from mpu.lib.resolver import ResolveError

runner = CliRunner()


@pytest.fixture
def fake_resolve(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, object]]:
    state: dict[str, object] = {"selector": None}

    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        state["selector"] = value
        return 2, [
            {"client_id": 54, "server": "sl-2", "server_number": 2},
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
    res = runner.invoke(cmd.app, ["sl-2"])

    assert res.exit_code == 0, res.output
    inner = fake_exec["inner"]
    assert isinstance(inner, str)
    assert "node src/pgDataTransfer.js transferTables" in inner
    assert "--s-host=192.168.150.32" in inner
    assert "--s-port=5432" in inner
    assert "--t-port 5441" in inner
    assert "--schema shared" in inner
    # Все таблицы из списка должны попасть в команду.
    for table in cmd.SHARED_TABLES:
        assert table in inner
    # Список таблиц идёт после --tables одним пробельным блоком.
    tables_part = inner.split("--tables ", 1)[1]
    assert tables_part.split() == list(cmd.SHARED_TABLES)
    assert fake_exec["command_name"] == "mpu-copy-shared"


def test_works_with_client_selector(
    fake_resolve: dict[str, object], fake_exec: dict[str, object]
) -> None:
    """copy-shared не требует client_id — селектор по клиенту тоже работает."""
    res = runner.invoke(cmd.app, ["54"])

    assert res.exit_code == 0, res.output
    inner = fake_exec["inner"]
    assert isinstance(inner, str)
    assert "--s-host=192.168.150.32" in inner


def test_resolve_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise ResolveError("nothing matched: 'x'", candidates=[])

    monkeypatch.setattr(cmd, "resolve_server", _raise)
    res = runner.invoke(cmd.app, ["x"])

    assert res.exit_code == 2
    assert "mpu-copy-shared: nothing matched" in res.output


def test_no_pg_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 9, []

    def _pg_ip(n: int) -> str | None:
        return None

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    monkeypatch.setattr(servers, "pg_ip", _pg_ip)
    res = runner.invoke(cmd.app, ["sl-9"])

    assert res.exit_code == 2
    assert "pg_9 not found" in res.output
