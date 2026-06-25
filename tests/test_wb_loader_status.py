"""Unit-тесты `mpu api wb-loader-status` (read-only GET status). HTTP/резолв мокаются."""

from __future__ import annotations

from typing import Any

import pytest
from click.testing import CliRunner

from mpu.commands import _wb_loader
from mpu.commands import wb_loader_status as wls

runner = CliRunner()

_FULL_SID = "57fc96d1-aadb-543d-976b-3a541ea2c3e5"


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


def _patch(
    monkeypatch: pytest.MonkeyPatch,
    *,
    api: FakeSlApi | None,
    candidates: list[dict[str, object]] | None = None,
) -> list[str]:
    clip: list[str] = []
    cands: list[dict[str, object]] = (
        candidates
        if candidates is not None
        else [{"client_id": 42, "server": "sl-2", "sids": ["S1"]}]
    )

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
    monkeypatch.setattr(wls, "resolve_base_url", _base)
    if api is not None:
        monkeypatch.setattr(wls.SlApi, "from_env", _from_env)
    return clip


def _cmd() -> Any:
    return wls.build_command()


def _path(sid: str, action: str) -> str:
    return _wb_loader.loader_path(sid, "adv-normquery-stats", action)


def test_status_get(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("GET", _path("S1", "status")): {
                "status": "idle",
                "state": {"lastLoadedDate": "2026-06-24"},
            }
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats"])
    assert result.exit_code == 0, result.output
    assert '"loader": "adv-normquery-stats"' in result.output
    assert '"lastLoadedDate"' in result.output
    assert api.calls == [("GET", _path("S1", "status"), None)]


def test_unknown_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "bogus"])
    assert result.exit_code == 2
    assert "неизвестный loader" in result.stderr


def test_print_emits_get_curl(monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _patch(monkeypatch, api=None)  # from_env не подменён → его вызов = AssertionError
    result = runner.invoke(_cmd(), ["42", "adv-normquery-stats", "--print"])
    assert result.exit_code == 0, result.output
    assert "TOKEN=$(mpu api get-token)" in result.output
    assert "curl -sS -X GET" in result.output
    assert _path("S1", "status") in result.output
    assert "-d '" not in result.output  # GET без тела
    assert clip and "curl -sS -X GET" in clip[0]


def test_full_sid_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("GET", _path(_FULL_SID, "status")): {"status": "loading"}})
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), [_FULL_SID, "adv-normquery-stats"])
    assert result.exit_code == 0, result.output
    assert f'"sid": "{_FULL_SID}"' in result.output
    assert api.calls == [("GET", _path(_FULL_SID, "status"), None)]
