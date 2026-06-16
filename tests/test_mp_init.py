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
    files = (
        ".sl-base.env",
        ".sl-0.env",
        ".sl-1.env",
        ".sw-back.base.env",
        "compose.mp-nats.yaml",
        "compose.sl-base.yaml",
        "compose.sl-pg.yaml",
        "compose.sl-main.yaml",
        "compose.pgbouncer.yaml",
        "compose.sl-instance.yaml",
        "compose.sw-back.yaml",
    )
    for name in files:
        (tmp_path / name).write_text("x")
    monkeypatch.setattr(dt_host, "mp_config_local_dir", lambda: tmp_path)
    monkeypatch.setattr(cmd.time, "sleep", lambda _s: None)

    state: dict[str, object] = {"calls": [], "network_exists": True, "sl_image_exists": True}

    def _run(argv: list[str], *, capture: bool = False) -> _Result:
        state["calls"].append(argv)  # type: ignore[union-attr]
        if argv[:3] == ["docker", "network", "inspect"]:
            return _Result(0 if state["network_exists"] else 1)
        if argv[:3] == ["docker", "image", "inspect"]:
            return _Result(0 if state["sl_image_exists"] else 1)
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
    # sl-0 (main) и sl-1 (instance) полные стеки подняты
    sl0 = next(j for j in joined if "compose.sl-main.yaml" in j)
    assert ".sl-0.env" in sl0 and " up -d" in sl0
    sl1 = next(j for j in joined if "compose.sl-instance.yaml" in j)
    assert ".sl-1.env" in sl1 and "compose.pgbouncer.yaml" in sl1
    # appMigrations гоняются на обоих серверах
    assert any(j == "docker exec mp-sl-0-cli node cli service:appMigrations latest" for j in joined)
    assert any(j == "docker exec mp-sl-1-cli node cli service:appMigrations latest" for j in joined)
    # sw-back собирается
    sw = next(j for j in joined if "compose.sw-back.yaml" in j)
    assert "--build" in sw
    assert "--force-recreate" not in sw
    # .env отсутствует → не пробрасывается, .sl-base.env пробрасывается
    nats = next(j for j in joined if "compose.mp-nats.yaml" in j)
    assert ".sl-base.env" in nats and "/.env" not in nats


def test_force_recreate(stack: dict[str, object]) -> None:
    res = runner.invoke(cmd.app, ["--force-recreate"])

    assert res.exit_code == 0, res.output
    joined = _joined(stack)
    for marker in ("compose.sl-main.yaml", "compose.sl-instance.yaml", "compose.sw-back.yaml"):
        up = next(j for j in joined if marker in j and " up -d" in j)
        assert "--force-recreate" in up, marker


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


def test_errors_when_sl_image_missing(stack: dict[str, object]) -> None:
    stack["sl_image_exists"] = False
    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 2, res.output
    assert "sl-build-image" in res.output
