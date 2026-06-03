"""Тесты `mpu move-client-back` (mpu.commands.move_client_back)."""

import pytest
from typer.testing import CliRunner

from mpu.commands import move_client_back as cmd
from mpu.lib import pssh
from mpu.lib.client_moves import Move

runner = CliRunner()


@pytest.fixture
def fake_run(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    captured: dict[str, object] = {"called": False}

    def _run(*, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        _ = stdin
        captured["called"] = True
        captured["cmd"] = cmd
        captured["container"] = container
        return 0

    monkeypatch.setattr(pssh, "pssh_run_container", _run)
    return captured


@pytest.fixture
def fake_clear(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    cleared: list[int] = []

    def _clear(client_id: int) -> None:
        cleared.append(client_id)

    monkeypatch.setattr(cmd, "clear_move", _clear)
    return cleared


def _set_last(monkeypatch: pytest.MonkeyPatch, move: Move | None) -> None:
    def _last(client_id: int) -> Move | None:
        _ = client_id
        return move

    monkeypatch.setattr(cmd, "last_move", _last)


# ── Реверс ──────────────────────────────────────────────────────────────────


def test_reverse_happy_int_selector(
    fake_run: dict[str, object], fake_clear: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, Move(client_id=1589, source="sl-13", target="sl-1", moved_at=1000))

    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 0, res.output
    # реверс: текущий sl-1 → домой sl-13
    assert fake_run["cmd"] == [
        "node",
        "cli",
        "service:clientsTransfer",
        "createJob",
        "--source",
        "sl-1",
        "--target",
        "sl-13",
        "--client-id",
        "1589",
        "--destroy",
    ]
    assert fake_run["container"] == "mp-dt-cli"
    assert fake_clear == [1589]


def test_reverse_no_record(fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch) -> None:
    _set_last(monkeypatch, None)

    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 2
    assert "нет записанного хода" in res.output
    assert fake_run["called"] is False


def test_reverse_corrupt_same_server(
    fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, Move(client_id=1589, source="sl-1", target="sl-1", moved_at=1000))

    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 2
    assert "оба sl-1" in res.output
    assert fake_run["called"] is False


def test_reverse_corrupt_bad_server(
    fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, Move(client_id=1589, source="xx", target="sl-1", moved_at=1000))

    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 2
    assert "повреждённая запись" in res.output
    assert fake_run["called"] is False


def test_reverse_run_failure_keeps_record(
    fake_clear: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, Move(client_id=1589, source="sl-13", target="sl-1", moved_at=1000))

    def _run(*, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        _ = container, cmd, stdin
        return 17

    monkeypatch.setattr(pssh, "pssh_run_container", _run)
    res = runner.invoke(cmd.app, ["1589"])

    assert res.exit_code == 17
    assert fake_clear == []  # запись не удаляем при неудаче


def test_reverse_title_selector_resolves(
    fake_run: dict[str, object], fake_clear: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    def _resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = value, server_override
        return 13, [{"client_id": 1589, "server": "sl-13", "server_number": 13}]

    monkeypatch.setattr(cmd, "resolve_server", _resolve)
    seen: dict[str, int] = {}

    def _last(client_id: int) -> Move | None:
        seen["id"] = client_id
        return Move(client_id=client_id, source="sl-13", target="sl-1", moved_at=1000)

    monkeypatch.setattr(cmd, "last_move", _last)

    res = runner.invoke(cmd.app, ["Acme"])

    assert res.exit_code == 0, res.output
    assert seen["id"] == 1589
    assert fake_clear == [1589]


# ── Список (ls / без аргументов) ─────────────────────────────────────────────


def _set_list(monkeypatch: pytest.MonkeyPatch, moves: list[Move]) -> dict[str, bool]:
    called: dict[str, bool] = {"list": False}

    def _list() -> list[Move]:
        called["list"] = True
        return moves

    monkeypatch.setattr(cmd, "list_moves", _list)
    return called


def test_list_no_args(fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch) -> None:
    _set_list(monkeypatch, [Move(client_id=1589, source="sl-13", target="sl-1", moved_at=1000)])

    res = runner.invoke(cmd.app, [])

    assert res.exit_code == 0, res.output
    assert "1589" in res.output
    assert "sl-13" in res.output
    assert "sl-1" in res.output
    assert fake_run["called"] is False


def test_list_ls_keyword(fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch) -> None:
    called = _set_list(
        monkeypatch, [Move(client_id=1589, source="sl-13", target="sl-1", moved_at=1000)]
    )

    res = runner.invoke(cmd.app, ["ls"])

    assert res.exit_code == 0, res.output
    assert called["list"] is True
    assert "1589" in res.output
    assert fake_run["called"] is False


def test_list_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_list(monkeypatch, [])

    res = runner.invoke(cmd.app, ["ls"])

    assert res.exit_code == 0, res.output
    assert "нет записанных ходов" in res.output


# ── Удаление записи (rm) ─────────────────────────────────────────────────────


def test_rm_happy(
    fake_run: dict[str, object], fake_clear: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, Move(client_id=1589, source="sl-13", target="sl-1", moved_at=1000))

    res = runner.invoke(cmd.app, ["rm", "1589"])

    assert res.exit_code == 0, res.output
    assert fake_clear == [1589]
    assert "удалена запись хода client 1589" in res.output
    assert fake_run["called"] is False  # rm не переносит


def test_rm_no_record(
    fake_run: dict[str, object], fake_clear: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_last(monkeypatch, None)

    res = runner.invoke(cmd.app, ["rm", "1589"])

    assert res.exit_code == 0, res.output
    assert "нет записи хода для client 1589" in res.output
    assert fake_clear == []
    assert fake_run["called"] is False


def test_rm_requires_selector(fake_run: dict[str, object], monkeypatch: pytest.MonkeyPatch) -> None:
    _ = monkeypatch
    res = runner.invoke(cmd.app, ["rm"])

    assert res.exit_code == 2
    assert "`rm` требует селектор" in res.output
    assert fake_run["called"] is False
