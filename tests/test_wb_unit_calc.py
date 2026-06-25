"""Snapshot-тесты `mpu wb-unit-calc get-unit-data-by-date-nm-id`
(service:wbUnitCalc getUnitDataByDateNmId, read-only debug).

`--date` опционален: при отсутствии подставляется `datetime.date.today()`.
Резолв `MODERNICA` → client_id=2190, sl-2.
"""

import datetime
from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import wb_unit_calc
from mpu.lib import cli_wrap, clipboard, servers

runner = CliRunner()

CANDIDATE: dict[str, object] = {
    "client_id": 2190,
    "spreadsheet_id": "1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c",
    "server": "sl-2",
    "title": "MODERNICA",
}

SSH_PREFIX = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-2-cli sh -c"
)


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def _fake_resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        if server_override:
            n = servers.server_number(server_override)
            assert n is not None, f"bad --server in test: {server_override!r}"
            return n, []
        sn = servers.server_number(value)
        if sn is not None:
            return sn, []
        return 2, [CANDIDATE]

    def _sl_ip(_n: int) -> str | None:
        return "192.168.150.92"

    def _env_value(k: str) -> str | None:
        return "hr82al" if k == "PG_MY_USER_NAME" else None

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_copy)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)
    yield


def _ssh(inner: str) -> str:
    return f'{SSH_PREFIX} "{inner}"\''


def test_wb_unit_calc_explicit_date_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        wb_unit_calc.app,
        [
            "get-unit-data-by-date-nm-id",
            "MODERNICA",
            "--nm-id",
            "139",
            "--date",
            "2026-04-01",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:wbUnitCalc getUnitDataByDateNmId "
        "--client-id 2190 --nm-id 139 --date 2026-04-01"
    )


def test_wb_unit_calc_explicit_date_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        wb_unit_calc.app,
        [
            "get-unit-data-by-date-nm-id",
            "MODERNICA",
            "--nm-id",
            "139",
            "--date",
            "2026-04-01",
            "--local",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:wbUnitCalc getUnitDataByDateNmId '
        '--client-id 2190 --nm-id 139 --date 2026-04-01"'
    )
    assert "ssh" not in result.stdout


def test_wb_unit_calc_date_defaults_to_today(fake_env: None) -> None:
    """Без --date подставляется сегодняшняя дата (YYYY-MM-DD)."""
    _ = fake_env
    today = datetime.date.today().isoformat()
    result = runner.invoke(
        wb_unit_calc.app,
        ["get-unit-data-by-date-nm-id", "MODERNICA", "--nm-id", "139", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:wbUnitCalc getUnitDataByDateNmId "
        f"--client-id 2190 --nm-id 139 --date {today}"
    )


def test_wb_unit_calc_client_id_override(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        wb_unit_calc.app,
        [
            "get-unit-data-by-date-nm-id",
            "MODERNICA",
            "--nm-id",
            "139",
            "--date",
            "2026-04-01",
            "--client-id",
            "555",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--client-id 555" in result.stdout
    assert "2190" not in result.stdout
