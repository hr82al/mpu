"""Unit-тесты `mpu api wb-loader-config` (GET config / enable / disable / reset).

HTTP/резолв мокаются."""

from __future__ import annotations

from typing import Any

import pytest
from click.testing import CliRunner

from mpu.commands import _wb_loader, wb_loader_config as wlc
from mpu.lib.slapi import SlApiError

runner = CliRunner()


class FakeSlApi:
    def __init__(self, responses: dict[tuple[str, str], Any]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, str, Any]] = []

    @classmethod
    def from_env(cls) -> FakeSlApi:
        raise AssertionError("from_env должен быть подменён")

    def request(
        self,
        method: str,
        pathname: str,
        *,
        body: Any = None,
        query: Any = None,
        no_auth: bool = False,
    ) -> Any:
        _ = query, no_auth
        self.calls.append((method, pathname, body))
        if (method, pathname) not in self._responses:
            raise AssertionError(f"unexpected request {method} {pathname}")
        value = self._responses[method, pathname]
        if isinstance(value, Exception):
            raise value
        return value


def _patch(monkeypatch: pytest.MonkeyPatch, *, api: FakeSlApi | None) -> list[str]:
    clip: list[str] = []
    cands: list[dict[str, object]] = [{"client_id": 42, "server": "sl-2", "sids": ["S1"]}]

    def _fake_resolve(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 2, cands

    def _clip(text: str) -> bool:
        clip.append(text)
        return True

    def _base() -> str:
        return "https://mp.example/api"

    def _from_env() -> FakeSlApi:
        assert api is not None
        return api

    monkeypatch.setattr(_wb_loader, "resolve_server", _fake_resolve)
    monkeypatch.setattr(_wb_loader, "copy_to_clipboard", _clip)
    monkeypatch.setattr(wlc, "resolve_base_url", _base)
    if api is not None:
        monkeypatch.setattr(wlc.SlApi, "from_env", _from_env)
    return clip


def _cmd() -> Any:
    return wlc.build_command()


def _path(action: str) -> str:
    return _wb_loader.loader_path("S1", "adv-upd", action)


def test_get_config_is_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("GET", _path("config")): {"effective": {"enabled": False}, "perSid": {}}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-upd"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("GET", _path("config"), None)]
    assert '"config"' in result.output


def test_enable_posts_partial_delta(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("config")): {"enabled": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--enable"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", _path("config"), {"enabled": True})]


def test_disable_posts_partial_delta(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("config")): {"enabled": False}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--disable"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", _path("config"), {"enabled": False})]


def test_reset_drops_per_sid_delta(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("config/reset")): {"enabled": False}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--reset"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", _path("config/reset"), None)]


def test_mutually_exclusive_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--enable", "--disable"])
    assert result.exit_code == 2
    assert "взаимоисключающие флаги" in result.stderr


def test_print_emits_curl_with_body(monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--enable", "--print"])
    assert result.exit_code == 0, result.output
    assert "curl -sS -X POST" in result.output
    assert _path("config") in result.output
    assert '"enabled": true' in result.output
    assert clip


def test_forbidden_403(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", _path("config")): SlApiError("forbidden", status=403, body="role required")}
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-upd", "--enable"])
    assert result.exit_code == 1
    assert "support_write" in result.stderr


def test_unknown_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "nope"])
    assert result.exit_code == 2
    assert "неизвестный loader" in result.stderr
