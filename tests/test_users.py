"""Snapshot-тесты `mpu users <selector> <method>` (service:users, обычно на sl-1/main).

`users` использует app-level callback (`attach_selector_callback`): `--print` / `--local`
и selector идут ПЕРЕД subcommand'ом (`users --print sl-1 add ...`).
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import users
from mpu.lib import cli_wrap, clipboard, servers

runner = CliRunner()

# sl-1 → IP 192.168.150.92, user hr82al, контейнер mp-sl-1-cli.
SSH_PREFIX_SL1 = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-1-cli sh -c"
)


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Фейковый резолв (sl-N short-circuit) + подмена ssh-lookup/clipboard на no-op."""

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
        return 2, []

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


def _ssh_sl1(inner: str) -> str:
    return f'{SSH_PREFIX_SL1} "{inner}"\''


def test_users_add_full_flags_ssh(fake_env: None) -> None:
    """Все опции add: --is-active (True) даёт голый флаг в конце."""
    _ = fake_env
    result = runner.invoke(
        users.app,
        [
            "--print",
            "sl-1",
            "add",
            "--email",
            "test@example.com",
            "--id",
            "10",
            "--user",
            "bob",
            "--name",
            "Bob",
            "--password",
            "secret123",
            "--is-active",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh_sl1(
        "node cli service:users add "
        "--email test@example.com --id 10 --user bob --name Bob "
        "--password secret123 --is-active"
    )


def test_users_add_no_is_active_skipped_ssh(fake_env: None) -> None:
    """`--no-is-active` → is_active=False → флаг ПРОПУСКАЕТСЯ (а не печатается)."""
    _ = fake_env
    result = runner.invoke(
        users.app,
        ["--print", "sl-1", "add", "--email", "a@b.co", "--no-is-active"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh_sl1("node cli service:users add --email a@b.co")
    assert "--is-active" not in result.stdout
    assert "--no-is-active" not in result.stdout


def test_users_add_role_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        users.app,
        ["--print", "sl-1", "add-role", "--id", "70", "--role", "client"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh_sl1("node cli service:users addRole --id 70 --role client")


def test_users_add_role_local(fake_env: None) -> None:
    """`--local --print` → форма `sl-N-cli sh -c "..."` без ssh."""
    _ = fake_env
    result = runner.invoke(
        users.app,
        ["--local", "--print", "sl-1", "add-role", "--id", "70", "--role", "client"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-1-cli sh -c "node cli service:users addRole --id 70 --role client"'
    )
    assert "ssh" not in result.stdout
