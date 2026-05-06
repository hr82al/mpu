"""Unit-тесты `mpu/lib/cli_wrap.py`."""
# pyright: reportPrivateUsage=false

from collections.abc import Sequence
from typing import Any

import pytest
import typer

from mpu.lib import cli_wrap, clipboard, servers
from mpu.lib.cli_wrap import (
    Resolved,
    _build_inner,
    _check_safe,
    _kebab,
    auto_pick_int,
    auto_pick_str,
    emit_node_cli,
    require,
    resolve_selector,
)
from mpu.lib.resolver import ResolveError


def _noop_clipboard(_t: str) -> bool:
    return True


def _fake_sl_ip(_n: int) -> str | None:
    return "10.0.0.3"


def _fake_env_value(k: str) -> str | None:
    return "alice" if k == "PG_MY_USER_NAME" else None


@pytest.fixture(autouse=True)
def silence_clipboard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_clipboard)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_clipboard)


@pytest.fixture
def fake_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    """Фейковый resolve_server: возвращает (3, [{client_id:42, spreadsheet_id:'SS', ...}])."""

    def _fake(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 3, [{"client_id": 42, "spreadsheet_id": "SS", "server": "sl-3", "title": "ACME"}]

    monkeypatch.setattr(cli_wrap, "resolve_server", _fake)
    monkeypatch.setattr(servers, "sl_ip", _fake_sl_ip)
    monkeypatch.setattr(servers, "env_value", _fake_env_value)


def _resolved_ssh() -> Resolved:
    return Resolved(server_number=3, sl_ip="10.0.0.3", user="alice", candidates=[])


def _resolved_local() -> Resolved:
    return Resolved(server_number=3, sl_ip=None, user=None, candidates=[])


# 1. basic
def test_basic_emit_ssh(capsys: pytest.CaptureFixture[str]) -> None:
    cmd = emit_node_cli(
        name="foo",
        method="bar",
        flags={"--client-id": 42, "--dataset": "ds"},
        resolved=_resolved_ssh(),
        command_name="mpu-test",
    )
    out = capsys.readouterr().out.strip()
    assert cmd == out
    assert cmd == (
        "ssh -i /home/user/.ssh/id_rsa -t alice@10.0.0.3 "
        "'docker exec -it mp-sl-3-cli sh -c "
        '"node cli service:foo bar --client-id 42 --dataset ds"\''
    )


# 2. None skipped
def test_none_value_skipped() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--domain": None, "--client-id": 1},
        command_name="mpu-test",
    )
    assert "--domain" not in inner
    assert "--client-id 1" in inner


# 3. False bool skipped
def test_false_bool_skipped() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--forced": False, "--client-id": 1},
        command_name="mpu-test",
    )
    assert "--forced" not in inner


# 4. True bool: bare flag, no trailing space
def test_true_bool_bare() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--client-id": 1, "--forced": True},
        command_name="mpu-test",
    )
    assert inner == "node cli service:foo bar --client-id 1 --forced"
    cmd = emit_node_cli(
        name="foo",
        method="bar",
        flags={"--forced": True},
        resolved=_resolved_ssh(),
        command_name="mpu-test",
    )
    # Inner внутри двойных кавычек — `--forced"` без пробела перед `"`.
    assert "--forced\"'" in cmd


# 5. List flag → space-separated
def test_list_flag() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--nm-ids": ["1", "2", "3"]},
        command_name="mpu-test",
    )
    assert "--nm-ids 1 2 3" in inner


# 6. JSON-array string form (без пробелов) проходит check_safe
def test_string_array_form_passes() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--nm-ids": "[1,2,3]"},
        command_name="mpu-test",
    )
    assert "--nm-ids [1,2,3]" in inner


# 7. check_safe: rejects unsafe chars
@pytest.mark.parametrize(
    "value",
    ["a b", "$(rm)", "a;b", "a'b", "{k:v}", 'a"b', "a|b"],
)
def test_check_safe_rejects(value: str, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(typer.Exit) as exc:
        _check_safe("--client-id", value, command_name="mpu-test")
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "--client-id" in err
    assert "shell-unsafe" in err


# 8. kebab-normalization
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("--client_id", "--client-id"),
        ("--client-id", "--client-id"),
        ("client_id", "--client-id"),
        ("client-id", "--client-id"),
        ("--logs", "--logs"),
    ],
)
def test_kebab_normalization(raw: str, expected: str) -> None:
    assert _kebab(raw) == expected
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={raw: 1},
        command_name="mpu-test",
    )
    assert f"{expected} 1" in inner


# 9. resolve_selector — ambiguous candidates
def test_resolve_ambiguous(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cands: list[dict[str, object]] = [
        {"client_id": 1, "server": "sl-1", "title": "A"},
        {"client_id": 2, "server": "sl-2", "title": "B"},
    ]

    def _raise(_v: str, *, server_override: str | None = None) -> Any:
        _ = server_override
        raise ResolveError("ambiguous", candidates=cands)

    monkeypatch.setattr(cli_wrap, "resolve_server", _raise)

    with pytest.raises(typer.Exit) as exc:
        resolve_selector(value="X", server=None, command_name="mpu-test")
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "mpu-test: ambiguous" in err
    assert 'title="A"' in err
    assert 'title="B"' in err


def _empty_resolve(
    _v: str, *, server_override: str | None = None
) -> tuple[int, list[dict[str, object]]]:
    _ = server_override
    return 3, []


def _none_sl_ip(_n: int) -> str | None:
    return None


# 10. resolve_selector — missing IP при require_ssh=True
def test_resolve_missing_ip_ssh(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli_wrap, "resolve_server", _empty_resolve)
    monkeypatch.setattr(servers, "sl_ip", _none_sl_ip)
    with pytest.raises(typer.Exit):
        resolve_selector(value="X", server=None, command_name="mpu-test")
    assert "no sl_3 in ~/.config/mpu/.env" in capsys.readouterr().err


# 11. resolve_selector(require_ssh=False) — пропускает sl_ip/env_value
def test_resolve_local_skips_ssh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli_wrap, "resolve_server", _empty_resolve)
    sl_ip_calls: list[int] = []
    env_value_calls: list[str] = []

    def _spy_sl_ip(n: int) -> str | None:
        sl_ip_calls.append(n)
        return "10.0.0.3"

    def _spy_env_value(k: str) -> str | None:
        env_value_calls.append(k)
        return "alice"

    monkeypatch.setattr(servers, "sl_ip", _spy_sl_ip)
    monkeypatch.setattr(servers, "env_value", _spy_env_value)

    resolved = resolve_selector(value="X", server=None, command_name="mpu-test", require_ssh=False)
    assert resolved.server_number == 3
    assert resolved.sl_ip is None
    assert resolved.user is None
    assert sl_ip_calls == []
    assert env_value_calls == []


# 12. wrapper="local"
def test_wrapper_local(capsys: pytest.CaptureFixture[str]) -> None:
    cmd = emit_node_cli(
        name="foo",
        method="bar",
        flags={"--client-id": 7},
        resolved=_resolved_local(),
        wrapper="local",
        command_name="mpu-test",
    )
    out = capsys.readouterr().out.strip()
    assert cmd == out
    assert cmd == 'sl-3-cli sh -c "node cli service:foo bar --client-id 7"'
    assert "ssh" not in cmd


# 13. auto_pick_int / auto_pick_str — distinct vs ambiguous
def test_auto_pick_int_distinct() -> None:
    assert auto_pick_int([{"client_id": 1}, {"client_id": 1}], "client_id") == 1
    assert auto_pick_int([{"client_id": 1}, {"client_id": 2}], "client_id") is None
    assert auto_pick_int([], "client_id") is None
    assert auto_pick_int([{"client_id": "x"}], "client_id") is None  # not int


def test_auto_pick_str_distinct() -> None:
    assert auto_pick_str([{"ss": "S"}, {"ss": "S"}], "ss") == "S"
    assert auto_pick_str([{"ss": "A"}, {"ss": "B"}], "ss") is None


# 14. require — pass-through vs Exit
def test_require_passes() -> None:
    assert require(42, flag="--x", candidates=[], command_name="t") == 42
    assert require("ok", flag="--y", candidates=[], command_name="t") == "ok"


def test_require_none_exits(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(typer.Exit) as exc:
        require(None, flag="--x", candidates=[{"client_id": 1, "server": "sl-1"}], command_name="t")
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "cannot resolve --x" in err
    assert "client_id=1" in err


# 15. emit_node_cli возвращает строку и она == stdout
def test_emit_returns_and_prints(fake_resolve: None, capsys: pytest.CaptureFixture[str]) -> None:
    _ = fake_resolve
    resolved = resolve_selector(value="X", server=None, command_name="t")
    cmd = emit_node_cli(
        name="foo",
        method="bar",
        flags={"--client-id": 42},
        resolved=resolved,
        command_name="t",
    )
    assert cmd == capsys.readouterr().out.strip()


# 16. Sequence[int] — числа допустимы
def test_sequence_of_ints() -> None:
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--nm-ids": [1, 2, 3]},
        command_name="t",
    )
    assert "--nm-ids 1 2 3" in inner


# 17. Custom entry/type — поддерживается
def test_custom_entry_and_type() -> None:
    inner = _build_inner(
        entry="sl-main",
        type_="model",
        name="users",
        method="findOne",
        flags={"--id": 7},
        command_name="t",
    )
    assert inner == "node sl-main model:users findOne --id 7"


# 18. emit_node_cli copies to clipboard
def test_emit_copies_to_clipboard(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[str] = []

    def _record(t: str) -> bool:
        captured.append(t)
        return True

    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _record)
    cmd = emit_node_cli(
        name="foo",
        method="bar",
        flags={"--client-id": 1},
        resolved=_resolved_ssh(),
        command_name="t",
    )
    assert captured == [cmd]


# 19. Empty Sequence — флаг пропускается
def test_empty_sequence_skipped() -> None:
    empty: Sequence[str] = []
    inner = _build_inner(
        entry="cli",
        type_="service",
        name="foo",
        method="bar",
        flags={"--nm-ids": empty, "--client-id": 1},
        command_name="t",
    )
    assert "--nm-ids" not in inner
    assert "--client-id 1" in inner


# 20. _wrap_ssh без sl_ip — internal error
def test_ssh_wrap_without_ip_errors(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(typer.Exit):
        emit_node_cli(
            name="foo",
            method="bar",
            flags={"--client-id": 1},
            resolved=_resolved_local(),  # sl_ip=None
            wrapper="ssh",
            command_name="t",
        )
    assert "internal error" in capsys.readouterr().err
