"""Тесты `mpu/commands/_portainer_resolve.py` — резолв селектора в Portainer Client.

Все внешние швы (`resolve_server`, `servers.portainer_target`, `servers.env_value`,
`typer.echo`) мокаются — без сети/SQLite/.env. Реальный `portainer.Client` (dataclass,
без I/O в конструкторе) НЕ мокается, чтобы проверять фактическую форму возврата.
"""

import pytest
import typer

from mpu.commands import _portainer_resolve as pr_mod
from mpu.commands._portainer_resolve import PortainerResolved, resolve_portainer
from mpu.lib import portainer, servers
from mpu.lib.resolver import ResolveError


class _EchoRecorder:
    """Записывает каждый `typer.echo(...)` как `(message, err)`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    def __call__(self, message: str = "", *, err: bool = False, **_kw: object) -> None:
        self.calls.append((message, err))


@pytest.fixture
def echo(monkeypatch: pytest.MonkeyPatch) -> _EchoRecorder:
    rec = _EchoRecorder()
    monkeypatch.setattr(typer, "echo", rec)
    return rec


def _patch_resolve(
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: tuple[int, list[dict[str, object]]] | None = None,
    error: ResolveError | None = None,
) -> None:
    def _fake(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = value, server_override
        if error is not None:
            raise error
        assert result is not None
        return result

    monkeypatch.setattr(pr_mod, "resolve_server", _fake)


def _patch_target(monkeypatch: pytest.MonkeyPatch, target: tuple[str, int] | None) -> None:
    def _fake(n: int) -> tuple[str, int] | None:
        _ = n
        return target

    monkeypatch.setattr(servers, "portainer_target", _fake)


def _patch_env(monkeypatch: pytest.MonkeyPatch, env: dict[str, str | None]) -> None:
    def _fake(key: str) -> str | None:
        return env.get(key)

    monkeypatch.setattr(servers, "env_value", _fake)


# ---------- success path ----------


def test_success_returns_resolved_with_real_client(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """Happy path: возвращается PortainerResolved с реальным portainer.Client."""
    _patch_resolve(monkeypatch, result=(11, [{"client_id": 7, "server": "sl-11"}]))
    _patch_target(monkeypatch, ("https://192.168.150.12:9443", 19))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "ptr_test"})

    out = resolve_portainer(selector="sl-11", command_name="mpu p ps")

    assert isinstance(out, PortainerResolved)
    assert out.server_number == 11
    assert out.endpoint_id == 19
    assert isinstance(out.client, portainer.Client)
    assert out.client.base_url == "https://192.168.150.12:9443"
    assert out.client.endpoint_id == 19
    assert out.client.api_key == "ptr_test"
    assert out.client.verify_tls is False
    # На успехе никакой вывод в stderr не идёт.
    assert echo.calls == []


def test_success_verify_tls_true(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    _ = echo
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k", "PORTAINER_VERIFY_TLS": "true"})

    out = resolve_portainer(selector="sl-11", command_name="cmd")
    assert out.client.verify_tls is True


def test_success_verify_tls_case_insensitive(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """`PORTAINER_VERIFY_TLS=TRUE` (любой регистр) → verify_tls=True."""
    _ = echo
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k", "PORTAINER_VERIFY_TLS": "TRUE"})

    out = resolve_portainer(selector="sl-11", command_name="cmd")
    assert out.client.verify_tls is True


def test_success_verify_tls_non_true_is_false(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """Любое значение кроме `true` → verify_tls=False (строгое сравнение)."""
    _ = echo
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k", "PORTAINER_VERIFY_TLS": "yes"})

    out = resolve_portainer(selector="sl-11", command_name="cmd")
    assert out.client.verify_tls is False


def test_success_verify_tls_missing_defaults_false(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """Нет PORTAINER_VERIFY_TLS в .env (None) → verify_tls=False, без падений."""
    _ = echo
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k"})

    out = resolve_portainer(selector="sl-11", command_name="cmd")
    assert out.client.verify_tls is False


# ---------- ResolveError path ----------


def test_resolve_error_without_candidates_exits_2(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """ResolveError без кандидатов → Exit(2), одна строка с command_name-префиксом."""
    _patch_resolve(monkeypatch, error=ResolveError("nothing matched: 'foo'"))
    _patch_target(monkeypatch, None)
    _patch_env(monkeypatch, {})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="foo", command_name="mpu p ps")

    assert ei.value.exit_code == 2
    # Кандидатов нет → format_candidates НЕ печатается (ровно один echo).
    assert echo.calls == [("mpu p ps: nothing matched: 'foo'", True)]


def test_resolve_error_with_candidates_prints_them(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    """Ambiguous ResolveError с кандидатами → Exit(2) + список кандидатов в stderr."""
    cands: list[dict[str, object]] = [
        {"client_id": 7, "server": "sl-1", "title": "ACME"},
        {"client_id": 8, "server": "sl-2"},
    ]
    _patch_resolve(
        monkeypatch,
        error=ResolveError("ambiguous selector 'x' — 2 candidates", candidates=cands),
    )
    _patch_target(monkeypatch, None)
    _patch_env(monkeypatch, {})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="x", command_name="cmd")

    assert ei.value.exit_code == 2
    assert len(echo.calls) == 2
    assert echo.calls[0] == ("cmd: ambiguous selector 'x' — 2 candidates", True)
    # Вторая строка — реальный format_candidates(): оба client_id и err=True.
    cand_line, cand_err = echo.calls[1]
    assert cand_err is True
    assert "client_id=7" in cand_line
    assert "client_id=8" in cand_line
    assert 'title="ACME"' in cand_line


# ---------- n <= 0 (sl-0 / negative) ----------


def test_server_zero_rejected(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    """n==0 (sl-0 не cli-таргет) → Exit(2) с сообщением 'ожидается sl-N (N>0)'."""
    _patch_resolve(monkeypatch, result=(0, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k"})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="sl-0", command_name="cmd")

    assert ei.value.exit_code == 2
    assert echo.calls == [("cmd: ожидается sl-N (N>0), получено: 'sl-0'", True)]


def test_server_negative_rejected(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    """Отрицательный n тоже отвергается (граница `n <= 0`)."""
    _patch_resolve(monkeypatch, result=(-1, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k"})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="weird", command_name="cmd")

    assert ei.value.exit_code == 2
    assert echo.calls == [("cmd: ожидается sl-N (N>0), получено: 'weird'", True)]


# ---------- portainer_target missing ----------


def test_no_portainer_target_exits_2(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    """Нет portainer-target для sl-N → Exit(2) с подсказкой про mpu init / .env."""
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, None)
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": "k"})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="sl-11", command_name="cmd")

    assert ei.value.exit_code == 2
    assert len(echo.calls) == 1
    msg, err = echo.calls[0]
    assert err is True
    assert msg.startswith("cmd: для sl-11 не найден portainer-target")


# ---------- PORTAINER_API_KEY missing ----------


def test_missing_api_key_exits_2(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    """PORTAINER_API_KEY не в .env (None) → Exit(2)."""
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="sl-11", command_name="cmd")

    assert ei.value.exit_code == 2
    assert len(echo.calls) == 1
    msg, err = echo.calls[0]
    assert err is True
    assert "PORTAINER_API_KEY не задан" in msg


def test_empty_api_key_exits_2(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    """Пустая строка PORTAINER_API_KEY (falsy) трактуется как «не задан» → Exit(2)."""
    _patch_resolve(monkeypatch, result=(11, []))
    _patch_target(monkeypatch, ("https://h:9443", 5))
    _patch_env(monkeypatch, {"PORTAINER_API_KEY": ""})

    with pytest.raises(typer.Exit) as ei:
        resolve_portainer(selector="sl-11", command_name="cmd")

    assert ei.value.exit_code == 2
    assert "PORTAINER_API_KEY не задан" in echo.calls[0][0]
