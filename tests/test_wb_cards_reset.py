"""Unit-тесты `mpu api wb-cards-reset` (после перевода на общий `_wb_loader`)."""

from __future__ import annotations

from typing import Any

import pytest
from click.testing import CliRunner

from mpu.commands import _wb_loader
from mpu.commands import wb_cards_reset as wcr
from mpu.lib.slapi import SlApiError

runner = CliRunner()

_RESET_PATH = _wb_loader.loader_path("S1", "cards", "reset")


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
    monkeypatch.setattr(wcr, "resolve_base_url", _base)
    if api is not None:
        monkeypatch.setattr(wcr.SlApi, "from_env", _from_env)
    return clip


def _cmd() -> Any:
    return wcr.build_command()


def test_reset_posts_cursor_null(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _RESET_PATH): {"success": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", _RESET_PATH, {"state": {"cursor": None}})]
    assert "full-pass" in result.output


def test_print_emits_reset_curl(monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "--print"])
    assert result.exit_code == 0, result.output
    assert "curl -sS -X POST" in result.output
    assert _RESET_PATH in result.output
    assert '"cursor": null' in result.output
    assert clip


def test_forbidden_403(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", _RESET_PATH): SlApiError("forbidden", status=403, body="role required")}
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42"])
    assert result.exit_code == 1
    assert "support_write" in result.stderr


def test_explicit_sid_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    sid = "57fc96d1-aadb-543d-976b-3a541ea2c3e5"
    path = _wb_loader.loader_path(sid, "cards", "reset")
    api = FakeSlApi({("POST", path): {"success": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "--sid", sid])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", path, {"state": {"cursor": None}})]
