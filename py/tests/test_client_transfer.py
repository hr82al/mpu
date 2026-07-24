"""Тесты `mpu.lib.client_transfer.run_transfer` — построение и запуск job переноса.

Транспорт (`pssh.pssh_run_container`) замокан: проверяется состав argv (`node cli
service:clientsTransfer createJob ...`), целевой контейнер, проброс rc и обработка
`ContainerResolveError` (обе ветки — с кандидатами и без).
"""

from __future__ import annotations

import pytest
import typer

from mpu.lib import client_transfer
from mpu.lib.containers import ContainerResolveError

_EXPECTED_CMD = [
    "node",
    "cli",
    "service:clientsTransfer",
    "createJob",
    "--source",
    "sl-1",
    "--target",
    "sl-2",
    "--client-id",
    "736",
    "--destroy",
]


def test_run_transfer_builds_cmd_and_returns_rc(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    captured: dict[str, object] = {}

    def _fake_run(*, container: str, cmd: list[str], **_kw: object) -> int:
        captured["container"] = container
        captured["cmd"] = cmd
        return 0

    monkeypatch.setattr(client_transfer.pssh, "pssh_run_container", _fake_run)

    rc = client_transfer.run_transfer("move-client", 736, source_n=1, target_n=2)

    assert rc == 0
    assert captured["container"] == client_transfer.MP_DT_CONTAINER
    assert captured["cmd"] == _EXPECTED_CMD
    # echo пишет реконструированную команду в stderr перед запуском.
    err = capsys.readouterr().err
    assert "node cli service:clientsTransfer createJob" in err
    assert client_transfer.MP_DT_CONTAINER in err


def test_run_transfer_propagates_nonzero_rc(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_run(*, container: str, cmd: list[str], **_kw: object) -> int:
        return 7

    monkeypatch.setattr(client_transfer.pssh, "pssh_run_container", _fake_run)

    rc = client_transfer.run_transfer("move-client-back", 100, source_n=2, target_n=1)

    assert rc == 7


def test_run_transfer_resolve_error_no_candidates(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def _raise(*, container: str, cmd: list[str], **_kw: object) -> int:
        raise ContainerResolveError("container 'mp-dt-cli' not found in Portainer cache")

    monkeypatch.setattr(client_transfer.pssh, "pssh_run_container", _raise)

    with pytest.raises(typer.Exit) as exc:
        client_transfer.run_transfer("move-client", 736, source_n=1, target_n=2)

    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "move-client: container 'mp-dt-cli' not found" in err
    # Без кандидатов — подсказка про обновление кэша.
    assert "mpu init" in err


def test_run_transfer_resolve_error_with_candidates(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    candidates: list[dict[str, object]] = [
        {
            "endpoint_name": "farm-a",
            "endpoint_id": 1,
            "portainer_url": "https://ptr.example",
            "container_name": "mp-dt-cli",
        }
    ]

    def _raise(*, container: str, cmd: list[str], **_kw: object) -> int:
        raise ContainerResolveError("ambiguous", candidates=candidates)

    monkeypatch.setattr(client_transfer.pssh, "pssh_run_container", _raise)

    with pytest.raises(typer.Exit) as exc:
        client_transfer.run_transfer("move-client-back", 100, source_n=2, target_n=1)

    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "move-client-back: ambiguous" in err
    # С кандидатами — выводится их форматированный список, не подсказка про кэш.
    assert "endpoint=farm-a" in err
    assert "mpu init" not in err
