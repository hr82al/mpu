"""Snapshot-тесты `mpu ss-load` (service:ssLoader load).

Селектор `MODERNICA` в фейковом резолве → client_id=2190, server=sl-2,
spreadsheet_id=1Mrx_...; ssh-обёртка предсказуема (sl-2 → IP 192.168.150.92).
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import ss_load
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


def test_ss_load_ssh(fake_env: None) -> None:
    """Дефолты: --logs info присутствует; --sheet-name/--forced опущены."""
    _ = fake_env
    result = runner.invoke(
        ss_load.app, ["MODERNICA", "--dataset", "wb10x_promotions_v3", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssLoader load --dataset wb10x_promotions_v3 "
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--logs info"
    )


def test_ss_load_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ss_load.app, ["MODERNICA", "--dataset", "wb10x_promotions_v3", "--local", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ssLoader load --dataset wb10x_promotions_v3 '
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        '--logs info"'
    )
    assert "ssh" not in result.stdout


def test_ss_load_forced_sheet_name_logs(fake_env: None) -> None:
    """--forced (голый флаг), --sheet-name (ASCII), --logs override."""
    _ = fake_env
    result = runner.invoke(
        ss_load.app,
        [
            "MODERNICA",
            "--dataset",
            "wb10x_promotions_v3",
            "--sheet-name",
            "Razdachi",
            "--forced",
            "--logs",
            "debug",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssLoader load --dataset wb10x_promotions_v3 "
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--sheet-name Razdachi "
        "--forced "
        "--logs debug"
    )


def test_ss_load_client_and_spreadsheet_override(fake_env: None) -> None:
    """Явные --client-id / --spreadsheet-id перекрывают авто-резолв из кандидата."""
    _ = fake_env
    result = runner.invoke(
        ss_load.app,
        [
            "MODERNICA",
            "--dataset",
            "wb10x_promotions_v3",
            "--client-id",
            "999",
            "--spreadsheet-id",
            "OVERRIDE_SS",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--client-id 999" in result.stdout
    assert "--spreadsheet-id OVERRIDE_SS" in result.stdout
    assert "2190" not in result.stdout


def test_ss_load_ambiguous_selector_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Неоднозначный селектор → ResolveError → typer.Exit(2) с печатью кандидатов."""
    from mpu.lib.resolver import ResolveError

    def _raise(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        raise ResolveError(
            "ambiguous selector",
            candidates=[{"client_id": 1, "server": "sl-1"}, {"client_id": 2, "server": "sl-2"}],
        )

    monkeypatch.setattr(cli_wrap, "resolve_server", _raise)
    result = runner.invoke(ss_load.app, ["VAGUE", "--dataset", "ds", "--print"])
    assert result.exit_code == 2
    assert "ambiguous" in result.output
