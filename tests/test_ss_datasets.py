"""Snapshot-тесты `mpu ss-datasets add` (service:ssDatasets add).

ssDatasets НЕ эмитит `--client-id` — только spreadsheet-id / dataset / sheet-name /
is-active. Резолв `MODERNICA` → spreadsheet_id=1Mrx_..., server=sl-2.
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import ss_datasets
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


def test_ss_datasets_add_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ss_datasets.app, ["add", "MODERNICA", "--dataset", "ozon10xUnit_v1", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssDatasets add "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--dataset ozon10xUnit_v1"
    )


def test_ss_datasets_add_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ss_datasets.app, ["add", "MODERNICA", "--dataset", "ozon10xUnit_v1", "--local", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ssDatasets add '
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        '--dataset ozon10xUnit_v1"'
    )
    assert "ssh" not in result.stdout


def test_ss_datasets_add_sheet_name_and_is_active(fake_env: None) -> None:
    """--sheet-name (ASCII) + --is-active (True → голый флаг в конце)."""
    _ = fake_env
    result = runner.invoke(
        ss_datasets.app,
        [
            "add",
            "MODERNICA",
            "--dataset",
            "ozon10xUnit_v1",
            "--sheet-name",
            "Sheet1",
            "--is-active",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssDatasets add "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--dataset ozon10xUnit_v1 "
        "--sheet-name Sheet1 "
        "--is-active"
    )


def test_ss_datasets_add_spreadsheet_override(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ss_datasets.app,
        [
            "add",
            "MODERNICA",
            "--dataset",
            "ozon10xUnit_v1",
            "--spreadsheet-id",
            "OVERRIDE_SS",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--spreadsheet-id OVERRIDE_SS" in result.stdout
    assert "1Mrx_" not in result.stdout
