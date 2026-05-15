"""Snapshot-тесты CLI-команд: фиксируют ровно тот stdout, что генерирует команда
с фиксированным резолвом и фейковым clipboard.

Назначение — байт-в-байт сравнение до/после миграции на `cli_wrap`.
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import (
    _ssh_node_cli,
    process,
    recalculate_wb_expenses,
    save_wb_expenses,
    ss_update,
)
from mpu.lib import cli_wrap, clipboard, resolver, servers

runner = CliRunner()

CANDIDATE: dict[str, object] = {
    "client_id": 2190,
    "spreadsheet_id": "1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c",
    "server": "sl-2",
    "title": "MODERNICA",
}


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Фейковый резолв client/server и подмена clipboard на no-op."""

    def _fake_resolve(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 2, [CANDIDATE]

    # cli_wrap импортирует resolve_server из mpu.lib.resolver — мокаем у источника
    # и в каждом call-site, который держит локальную ссылку.
    monkeypatch.setattr(resolver, "resolve_server", _fake_resolve)
    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    if hasattr(_ssh_node_cli, "resolve_server"):
        monkeypatch.setattr(_ssh_node_cli, "resolve_server", _fake_resolve)
    if hasattr(ss_update, "resolve_server"):
        monkeypatch.setattr(ss_update, "resolve_server", _fake_resolve)

    def _sl_ip(_n: int) -> str | None:
        return "192.168.150.92"

    def _env_value(k: str) -> str | None:
        return "hr82al" if k == "PG_MY_USER_NAME" else None

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_copy)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)

    yield


SSH_PREFIX = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-2-cli sh -c"
)


# ── ssh-форма ────────────────────────────────────────────────────────────────


def test_ss_update_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(ss_update.app, ["MODERNICA", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f"{SSH_PREFIX} "
        '"node cli service:ssUpdater update '
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--update-type schedule "
        "--logs info\"'"
    )


def test_process_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2026-05-06", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f"{SSH_PREFIX} "
        '"node cli service:dataProcessor process '
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--date-from 2025-01-01 "
        "--date-to 2026-05-06\"'"
    )


def test_recalculate_wb_expenses_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_wb_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f"{SSH_PREFIX} "
        '"node cli service:wbUnitCalculatedData recalculateExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        "--date-to 2025-01-31\"'"
    )


def test_save_wb_expenses_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        save_wb_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f"{SSH_PREFIX} "
        '"node cli service:wbUnitCalculatedData saveExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        "--date-to 2025-01-31\"'"
    )


# ── --local форма (после миграции) ───────────────────────────────────────────
# До миграции: --local не существует, выход 2. После — sl-2-cli sh -c "...".


def test_ss_update_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(ss_update.app, ["MODERNICA", "--local", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ssUpdater update '
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--update-type schedule "
        '--logs info"'
    )


def test_process_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--local", "--date-from", "2025-01-01", "--date-to", "2026-05-06", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:dataProcessor process '
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--date-from 2025-01-01 "
        '--date-to 2026-05-06"'
    )


def test_recalculate_wb_expenses_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_wb_expenses.app,
        ["MODERNICA", "--local", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:wbUnitCalculatedData recalculateExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        '--date-to 2025-01-31"'
    )


def test_save_wb_expenses_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        save_wb_expenses.app,
        ["MODERNICA", "--local", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:wbUnitCalculatedData saveExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        '--date-to 2025-01-31"'
    )


# ── process: новые опции после рефактора ──────────────────────────────────────


def test_process_forced(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--forced", "--date-from", "2025-05-01", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--forced" in result.stdout
    assert "--date-from 2025-05-01" in result.stdout


def test_process_dry_run_and_logs(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--dry-run", "--logs", "debug", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--dry-run" in result.stdout
    assert "--logs debug" in result.stdout


def test_process_domain_and_tags(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        [
            "MODERNICA",
            "--domain", "wb",
            "--with-tags", "persistent",
            "--with-tags", "wb",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--domain wb" in result.stdout
    assert "--with-tags persistent wb" in result.stdout


def test_process_with_tags_single_value_duplicated(fake_env: None) -> None:
    """sl-back parseMethodArgs single-value collapse workaround: mpu дублирует."""
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--with-tags", "persistent", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--with-tags persistent persistent" in result.stdout


def test_process_exclude_datasets(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        [
            "MODERNICA",
            "--exclude-datasets", "wb10xUnit_v1",
            "--exclude-datasets", "wb10xPromotions_v3",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--exclude-datasets wb10xUnit_v1 wb10xPromotions_v3" in result.stdout


def test_process_skus_emitted_as_bracket(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--skus", "1", "--skus", "2", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--skus [1,2]" in result.stdout


def test_process_no_deps_and_dataset(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--no-deps", "--dataset", "wb10xUnit_v1", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--no-deps" in result.stdout
    assert "--dataset wb10xUnit_v1" in result.stdout


def test_process_verbose_prints_inner_to_stderr(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        process.app,
        ["MODERNICA", "--forced", "-v", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "# inner: node cli service:dataProcessor process" in result.output
    assert "--forced" in result.output
