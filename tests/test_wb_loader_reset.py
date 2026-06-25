"""Unit-тесты `mpu api wb-loader-reset` (reset + опц. load). HTTP/резолв мокаются."""

from __future__ import annotations

from typing import Any

import pytest
from click.testing import CliRunner

from mpu.commands import _wb_loader
from mpu.commands import wb_loader_reset as wlr
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
    monkeypatch.setattr(wlr, "resolve_base_url", _base)
    if api is not None:
        monkeypatch.setattr(wlr.SlApi, "from_env", _from_env)
    return clip


def _cmd() -> Any:
    return wlr.build_command()


def _path(action: str) -> str:
    return _wb_loader.loader_path("S1", "adv-normquery-stats", action)


def test_reset_empty_body(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("reset")): {"success": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats"])
    assert result.exit_code == 0, result.output
    assert api.calls == [("POST", _path("reset"), None)]  # пустое тело


def test_reset_with_state(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("reset")): {"success": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(
        _cmd(), ["42", "adv-normquery-stats", "--state", '{"lastLoadedDate":"2026-06-08"}']
    )
    assert result.exit_code == 0, result.output
    reset = next(c for c in api.calls if c[1] == _path("reset"))
    assert reset[2] == {"state": {"lastLoadedDate": "2026-06-08"}}


def test_reset_from_forward_only(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", _path("reset")): {"success": True}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats", "--from", "2026-06-09"])
    assert result.exit_code == 0, result.output
    reset = next(c for c in api.calls if c[1] == _path("reset"))
    assert reset[2] == {"state": {"lastLoadedDate": "2026-06-08"}}  # from - 1 день


def test_from_non_forward_only_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "cards", "--from", "2026-06-09"])
    assert result.exit_code == 2
    assert "не forward-only" in result.stderr


def test_state_and_from_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(
        _cmd(), ["42", "adv-normquery-stats", "--state", "{}", "--from", "2026-06-09"]
    )
    assert result.exit_code == 2
    assert "взаимоисключающи" in result.stderr


def test_state_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats", "--state", "{nope"])
    assert result.exit_code == 2
    assert "невалидный JSON" in result.stderr


def test_state_not_object(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats", "--state", "[1,2]"])
    assert result.exit_code == 2
    assert "ожидается JSON-объект" in result.stderr


def test_from_invalid_date(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats", "--from", "09.06.2026"])
    assert result.exit_code == 2
    assert "YYYY-MM-DD" in result.stderr


def test_and_load(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", _path("reset")): {"success": True},
            ("POST", _path("load")): {"success": True},
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(
        _cmd(), ["42", "adv-normquery-stats", "--from", "2026-06-09", "--and-load"]
    )
    assert result.exit_code == 0, result.output
    paths = [c[1] for c in api.calls]
    assert paths == [_path("reset"), _path("load")]
    assert '"load"' in result.output


def test_print_reset_and_load_curl(monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _patch(monkeypatch, api=None)
    result = runner.invoke(
        _cmd(), ["42", "adv-normquery-stats", "--from", "2026-06-09", "--and-load", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert _path("reset") in result.output
    assert _path("load") in result.output
    assert '"lastLoadedDate": "2026-06-08"' in result.output
    assert clip


def test_forbidden_403(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", _path("reset")): SlApiError("forbidden", status=403, body="role required")}
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats"])
    assert result.exit_code == 1
    assert "support_write" in result.stderr


def test_unknown_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "zzz"])
    assert result.exit_code == 2
    assert "неизвестный loader" in result.stderr
