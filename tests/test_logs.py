"""Тесты `commands/logs.py` — диспетчер `mpu logs` (loki по умолчанию vs portainer).

CLI гоняется через `CliRunner`; оба бэкенда (`_logs_loki.*`, `_logs_portainer.run`)
и `ls`-листинги замоканы рекордерами, так что проверяется ровно маршрутизация и
разбор опций, без сети/SQLite. `is_direct_host` оставлен реальным (чистая regex-логика),
`cached_all_services` подменяется типизированным фейком.
"""
# тестируем приватные _complete_* и логику main() напрямую → нужен доступ к private-символам
# pyright: reportPrivateUsage=false

from collections.abc import Callable
from dataclasses import dataclass

import click
import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import _logs_loki, _logs_portainer, logs

runner = CliRunner()


class _Recorder:
    """Записывает каждый вызов как `(args, kwargs)`; возвращает None (все бэкенды void)."""

    def __init__(self) -> None:
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args: object, **kwargs: object) -> None:
        self.calls.append((args, kwargs))

    @property
    def called(self) -> bool:
        return bool(self.calls)

    @property
    def last_kwargs(self) -> dict[str, object]:
        return self.calls[-1][1]

    @property
    def last_args(self) -> tuple[object, ...]:
        return self.calls[-1][0]


@dataclass
class _Backends:
    loki_run: _Recorder
    loki_follow: _Recorder
    portainer_run: _Recorder
    hosts_ls: _Recorder
    services_ls: _Recorder
    all_services_ls: _Recorder


def _const_services(values: list[str]) -> Callable[[], list[str]]:
    def _fn() -> list[str]:
        return values

    return _fn


def _services_for(values: list[str]) -> Callable[[str], list[str]]:
    def _fn(host: str) -> list[str]:
        _ = host
        return values

    return _fn


@pytest.fixture
def backends(monkeypatch: pytest.MonkeyPatch) -> _Backends:
    b = _Backends(
        loki_run=_Recorder(),
        loki_follow=_Recorder(),
        portainer_run=_Recorder(),
        hosts_ls=_Recorder(),
        services_ls=_Recorder(),
        all_services_ls=_Recorder(),
    )
    monkeypatch.setattr(_logs_loki, "run", b.loki_run)
    monkeypatch.setattr(_logs_loki, "follow", b.loki_follow)
    monkeypatch.setattr(_logs_portainer, "run", b.portainer_run)
    monkeypatch.setattr(_logs_loki, "print_hosts_ls", b.hosts_ls)
    monkeypatch.setattr(_logs_loki, "print_services_ls", b.services_ls)
    monkeypatch.setattr(_logs_loki, "print_all_services_ls", b.all_services_ls)
    # По умолчанию кэш services пуст — non-direct селектор НЕ трактуется как service.
    monkeypatch.setattr(_logs_loki, "cached_all_services", _const_services([]))
    return b


# ── ls-режимы ─────────────────────────────────────────────────────────────────


def test_ls_lists_hosts(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["ls"])
    assert result.exit_code == 0, result.output
    assert backends.hosts_ls.called
    assert backends.hosts_ls.last_kwargs == {"command_name": "mpu logs"}
    # Прочие бэкенды не тронуты.
    assert not backends.loki_run.called
    assert not backends.services_ls.called


def test_service_ls_lists_for_host(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "ls"])
    assert result.exit_code == 0, result.output
    assert backends.services_ls.called
    assert backends.services_ls.last_args == ("sl-1",)
    assert backends.services_ls.last_kwargs == {"command_name": "mpu logs"}
    assert not backends.all_services_ls.called
    assert not backends.loki_run.called


# ── loki (default) ────────────────────────────────────────────────────────────


def test_loki_run_direct_host_defaults(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1"])
    assert result.exit_code == 0, result.output
    assert backends.loki_run.called
    kw = backends.loki_run.last_kwargs
    assert kw["command_name"] == "mpu logs"
    assert kw["selector"] == "sl-1"
    assert kw["service"] is None
    assert kw["tail"] == 200
    assert kw["since"] is None
    assert kw["timestamps"] is False
    assert kw["no_stdout"] is False
    assert kw["no_stderr"] is False
    assert kw["grep"] == []
    assert kw["grep_regex"] == []
    assert kw["level"] is None
    assert kw["client_id"] is None
    assert not backends.loki_follow.called
    assert not backends.portainer_run.called


def test_loki_run_no_selector_all_hosts(backends: _Backends) -> None:
    result = runner.invoke(logs.app, [])
    assert result.exit_code == 0, result.output
    assert backends.loki_run.called
    assert backends.loki_run.last_kwargs["selector"] is None
    assert backends.loki_run.last_kwargs["service"] is None


def test_loki_run_options_passthrough(backends: _Backends) -> None:
    result = runner.invoke(
        logs.app,
        [
            "sl-1",
            "--tail",
            "50",
            "--since",
            "1h",
            "-t",
            "--no-stdout",
            "--no-stderr",
            "--grep",
            "A",
            "--grep",
            "B",
            "--grep-regex",
            "R",
            "--level",
            "error",
            "--client",
            "42",
        ],
    )
    assert result.exit_code == 0, result.output
    kw = backends.loki_run.last_kwargs
    assert kw["tail"] == 50
    assert kw["since"] == "1h"
    assert kw["timestamps"] is True
    assert kw["no_stdout"] is True
    assert kw["no_stderr"] is True
    assert kw["grep"] == ["A", "B"]
    assert kw["grep_regex"] == ["R"]
    assert kw["level"] == "error"
    assert kw["client_id"] == 42


def test_service_inference_non_direct_in_cache(
    backends: _Backends, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`mpu logs wb-loader` → selector это service из кэша → host=all."""
    monkeypatch.setattr(_logs_loki, "cached_all_services", _const_services(["wb-loader"]))
    result = runner.invoke(logs.app, ["wb-loader"])
    assert result.exit_code == 0, result.output
    kw = backends.loki_run.last_kwargs
    assert kw["selector"] is None
    assert kw["service"] == "wb-loader"


def test_non_direct_not_in_cache_passthrough_as_selector(backends: _Backends) -> None:
    """Непрямой host, которого нет среди services → остаётся selector'ом (резолвится в run)."""
    result = runner.invoke(logs.app, ["MODERNICA"])
    assert result.exit_code == 0, result.output
    kw = backends.loki_run.last_kwargs
    assert kw["selector"] == "MODERNICA"
    assert kw["service"] is None


def test_follow_dispatches_to_loki_follow(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "--follow"])
    assert result.exit_code == 0, result.output
    assert backends.loki_follow.called
    assert not backends.loki_run.called
    kw = backends.loki_follow.last_kwargs
    assert kw["selector"] == "sl-1"
    assert kw["service"] is None
    assert kw["command_name"] == "mpu logs"
    # follow не принимает tail.
    assert "tail" not in kw


def test_loki_run_idempotent(backends: _Backends) -> None:
    first = runner.invoke(logs.app, ["sl-1"])
    second = runner.invoke(logs.app, ["sl-1"])
    assert first.exit_code == 0
    assert second.exit_code == 0
    assert len(backends.loki_run.calls) == 2
    assert backends.loki_run.calls[0] == backends.loki_run.calls[1]


# ── portainer ─────────────────────────────────────────────────────────────────


def test_portainer_dispatch(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "wb-loader", "--via", "portainer"])
    assert result.exit_code == 0, result.output
    assert backends.portainer_run.called
    assert not backends.loki_run.called
    kw = backends.portainer_run.last_kwargs
    assert kw["command_name"] == "mpu logs"
    assert kw["selector"] == "sl-1"
    assert kw["container"] == "wb-loader"
    assert kw["tail"] == 200
    assert kw["since"] is None
    assert kw["timestamps"] is False
    assert kw["no_stdout"] is False
    assert kw["no_stderr"] is False


def test_portainer_options_passthrough(backends: _Backends) -> None:
    result = runner.invoke(
        logs.app,
        [
            "sl-1",
            "wb-loader",
            "--via",
            "portainer",
            "--tail",
            "10",
            "--since",
            "2h",
            "-t",
            "--no-stdout",
        ],
    )
    assert result.exit_code == 0, result.output
    kw = backends.portainer_run.last_kwargs
    assert kw["tail"] == 10
    assert kw["since"] == "2h"
    assert kw["timestamps"] is True
    assert kw["no_stdout"] is True


def test_portainer_requires_selector(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["--via", "portainer"])
    assert result.exit_code == 2
    assert "требует <selector>" in result.output
    assert not backends.portainer_run.called


def test_portainer_requires_container(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "--via", "portainer"])
    assert result.exit_code == 2
    assert "требует <container>" in result.output
    assert not backends.portainer_run.called


def test_portainer_follow_unsupported(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "wb-loader", "--via", "portainer", "--follow"])
    assert result.exit_code == 2
    assert "--follow не поддерживается" in result.output
    assert not backends.portainer_run.called


# ── невалидный --via ──────────────────────────────────────────────────────────


def test_invalid_via_exits_2(backends: _Backends) -> None:
    result = runner.invoke(logs.app, ["sl-1", "--via", "bogus"])
    assert result.exit_code == 2
    assert "ожидается 'loki' или 'portainer'" in result.output
    assert not backends.loki_run.called
    assert not backends.portainer_run.called


# ── service == 'ls' с selector=None (недостижимо через CLI-позиционные) ────────


def test_main_service_ls_no_selector_lists_all(backends: _Backends) -> None:
    """`service='ls'` при `selector=None` → `print_all_services_ls` (прямой вызов main)."""
    logs.main(
        selector=None,
        service="ls",
        via="loki",
        tail=200,
        since=None,
        timestamps=False,
        no_stdout=False,
        no_stderr=False,
        grep=None,
        grep_regex=None,
        level=None,
        client_id=None,
        follow=False,
    )
    assert backends.all_services_ls.called
    assert backends.all_services_ls.last_kwargs == {"command_name": "mpu logs"}
    assert not backends.services_ls.called


# ── autocompletion-хелперы ────────────────────────────────────────────────────


def test_complete_selector_filters_by_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_logs_loki, "cached_hosts", _const_services(["sl-1", "sl-2", "wb-0"]))
    assert logs._complete_selector("s") == ["sl-1", "sl-2"]
    # пустой префикс отдаёт 'ls' + все hosts.
    assert logs._complete_selector("") == ["ls", "sl-1", "sl-2", "wb-0"]
    assert logs._complete_selector("l") == ["ls"]


def _ctx(selector: object) -> typer.Context:
    ctx = typer.Context(click.Command("logs"))
    ctx.params = {"selector": selector}
    return ctx


def test_complete_service_host_selected_uses_per_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_logs_loki, "cached_hosts", _const_services(["sl-1"]))
    monkeypatch.setattr(
        _logs_loki, "cached_services_for_host", _services_for(["api", "internal-api"])
    )
    out = logs._complete_service(_ctx("sl-1"), "")
    assert out == ["ls", "api", "internal-api"]
    assert logs._complete_service(_ctx("sl-1"), "i") == ["internal-api"]


def test_complete_service_non_host_uses_all(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_logs_loki, "cached_hosts", _const_services(["sl-1"]))
    monkeypatch.setattr(_logs_loki, "cached_all_services", _const_services(["wb-loader"]))
    # selector не из hosts → общий список services.
    assert logs._complete_service(_ctx("CLIENT"), "") == ["ls", "wb-loader"]
    # selector отсутствует (None) → тоже общий список.
    assert logs._complete_service(_ctx(None), "wb") == ["wb-loader"]


def test_complete_via() -> None:
    assert logs._complete_via("") == ["loki", "portainer"]
    assert logs._complete_via("p") == ["portainer"]
    assert logs._complete_via("x") == []


def test_complete_level() -> None:
    assert logs._complete_level("") == ["error", "warn", "info", "debug"]
    assert logs._complete_level("e") == ["error"]
    assert logs._complete_level("z") == []
