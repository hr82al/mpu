"""Snapshot-тесты `mpu data-loader find-candidate` (service:dataLoader findCandidate).

`--sids` / `--sid` — повторяемый флаг (`list[str]`), эмитится как `--sids a b c`
(sl-back parseMethodArgs читает массивом). Резолв `MODERNICA` → client_id=2190, sl-2.
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import data_loader
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


def test_data_loader_find_candidate_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        [
            "find-candidate",
            "MODERNICA",
            "--sids",
            "41a47777-e1e3-41ca-9708-d9656be3deb7",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:dataLoader findCandidate "
        "--client-id 2190 --sids 41a47777-e1e3-41ca-9708-d9656be3deb7"
    )


def test_data_loader_find_candidate_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        ["find-candidate", "MODERNICA", "--sid", "abcd", "--local", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:dataLoader findCandidate --client-id 2190 --sids abcd"'
    )
    assert "ssh" not in result.stdout


def test_data_loader_multiple_sids(fake_env: None) -> None:
    """Повтор --sids/--sid → пробел-разделённый список после флага."""
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        ["find-candidate", "MODERNICA", "--sids", "aaa", "--sid", "bbb", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:dataLoader findCandidate --client-id 2190 --sids aaa bbb"
    )


def test_data_loader_client_id_override(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        ["find-candidate", "MODERNICA", "--sid", "abcd", "--client-id", "555", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--client-id 555" in result.stdout
    assert "2190" not in result.stdout


def test_data_loader_unsafe_sid_exits(fake_env: None) -> None:
    """sid с пробелом → shell-unsafe guard → typer.Exit(2)."""
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        ["find-candidate", "MODERNICA", "--sids", "a b", "--print"],
    )
    assert result.exit_code == 2
    assert "shell-unsafe" in result.output
