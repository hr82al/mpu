"""Тесты `mpu mp-init` (mpu.commands.mp_init)."""

from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import mp_init as cmd
from mpu.lib import dt_host

runner = CliRunner()


class _Result:
    def __init__(self, returncode: int, stdout: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, object]:
    """Фейковый mp-config-local + перехват `_run`. `.env` намеренно отсутствует."""
    files = (".sw-back.base.env", "compose.mp-nats.yaml", "compose.sw-back.yaml", ".sl-base.env")
    for name in files:
        (tmp_path / name).write_text("x")
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: tmp_path)

    state: dict[str, object] = {"calls": [], "network_exists": True, "sl_running": True}

    def _run(argv: list[str], *, capture: bool = False) -> _Result:
        state["calls"].append(argv)  # type: ignore[union-attr]
        if argv[:3] == ["docker", "network", "inspect"]:
            return _Result(0 if state["network_exists"] else 1)
        if argv[:2] == ["docker", "ps"]:
            return _Result(0, "mp-sl-1-i-internal-api\n" if state["sl_running"] else "")
        return _Result(0)

    monkeypatch.setattr(cmd, "_run", _run)
    return state


def _joined(state: dict[str, object]) -> list[str]:
    return [" ".join(a) for a in state["calls"]]  # type: ignore[union-attr]


def test_basic_up(stack: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    joined = _joined(stack)
    assert any("network inspect mp-shared-net" in j for j in joined)
    assert any("compose.mp-nats.yaml" in j and " up -d" in j for j in joined)
    sw = next(j for j in joined if "compose.sw-back.yaml" in j)
    assert "--build" in sw
    assert "--force-recreate" not in sw
    # .env отсутствует → не пробрасывается, .sl-base.env пробрасывается
    nats = next(j for j in joined if "compose.mp-nats.yaml" in j)
    assert ".sl-base.env" in nats and "/.env" not in nats


def test_force_recreate(stack: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, ["--force-recreate"])

    assert res.exit_code == 0, res.output
    sw = next(j for j in _joined(stack) if "compose.sw-back.yaml" in j)
    assert "--force-recreate" in sw


def test_no_build(stack: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, ["--no-build"])

    assert res.exit_code == 0, res.output
    sw = next(j for j in _joined(stack) if "compose.sw-back.yaml" in j)
    assert "--build" not in sw


def test_creates_network_when_missing(stack: dict[str, object]) -> None:
    stack["network_exists"] = False
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert any("network create" in j for j in _joined(stack))


def test_warns_when_sl_internal_api_down(stack: dict[str, object]) -> None:
    stack["sl_running"] = False
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "mp-sl-1-i-internal-api не запущен" in res.output
