"""Unit-тесты `mpu api wb-loader-resume` (`commands/wb_loader_resume.py`).

Резолв селектора и HTTP мокаются — без сети. sid берётся из кэшированных
`sids` кандидата `resolve_server` (как после расширения `mpu search` по sid).
"""

from __future__ import annotations

from typing import Any

import pytest
from click.testing import CliRunner

from mpu.commands import wb_loader_resume as wlr
from mpu.lib.resolver import ResolveError

runner = CliRunner()


class FakeSlApi:
    """Подмена `SlApi`: отдаёт ответы по (method, path) или кидает. Только find/resume."""

    base_url = "https://mp.example/api"

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
    resolve_exc: ResolveError | None = None,
) -> list[str]:
    """Мок resolve_server / SlApi / clipboard / base_url. Возвращает буфер clipboard."""
    clip: list[str] = []
    cands: list[dict[str, object]] = (
        candidates
        if candidates is not None
        else [{"client_id": 42, "server": "sl-2", "sids": ["S1"]}]
    )

    def _fake_resolve(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        if resolve_exc is not None:
            raise resolve_exc
        return 2, cands

    def _base() -> str:
        return "https://mp.example/api"

    def _clip(text: str) -> bool:
        clip.append(text)
        return True

    def _from_env() -> FakeSlApi:
        assert api is not None
        return api

    monkeypatch.setattr(wlr, "resolve_server", _fake_resolve)
    monkeypatch.setattr(wlr, "resolve_base_url", _base)
    monkeypatch.setattr(wlr, "copy_to_clipboard", _clip)
    if api is not None:
        monkeypatch.setattr(wlr.SlApi, "from_env", _from_env)
    return clip


def _cmd() -> Any:
    return wlr.build_command()


# 1. SHOW: без loader/--all — find вызван, resume НЕ вызван.
def test_show_mode_single_sid(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {  # pyright: ignore[reportPrivateUsage]
                "data": [{"sid": "S1", "loader": "wbAnalytics", "blocked_reason": "unknown_error"}]
            }
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42"])
    assert result.exit_code == 0, result.output
    assert '"blocked"' in result.output
    assert '"loader": "wbAnalytics"' in result.output
    assert all(c[1] != wlr._RESUME_PATH for c in api.calls)  # pyright: ignore[reportPrivateUsage]


# 2. resume конкретного loader.
def test_resume_specific_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {"data": []},  # pyright: ignore[reportPrivateUsage]
            ("POST", wlr._RESUME_PATH): {  # pyright: ignore[reportPrivateUsage]
                "resumed": 1,
                "items": [{"sid": "S1", "loader": "wbAnalytics", "prevReason": "unknown_error"}],
            },
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "wbAnalytics"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {"filter": {"sid": "S1", "loader": "wbAnalytics"}}
    assert '"resumed": 1' in result.output


# 3. --all → filter без loader.
def test_resume_all(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {"data": []},  # pyright: ignore[reportPrivateUsage]
            ("POST", wlr._RESUME_PATH): {"resumed": 3, "items": []},  # pyright: ignore[reportPrivateUsage]
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "--all"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {"filter": {"sid": "S1"}}


# 4. --all + loader — конфликт (до резолва).
def test_all_and_loader_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "wbAnalytics", "--all"])
    assert result.exit_code == 2
    assert "взаимоисключающи" in result.stderr


# 5. Неизвестный loader.
def test_unknown_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "wbBogus"])
    assert result.exit_code == 2
    assert "неизвестный loader" in result.stderr


# 6. Несколько sid, селектор не sid, без --sid → exit 2 + список.
def test_multi_sid_requires_sid(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({})
    _patch(
        monkeypatch,
        api=api,
        candidates=[{"client_id": 42, "server": "sl-2", "sids": ["S1", "S2"]}],
    )
    result = runner.invoke(_cmd(), ["42", "wbAnalytics"])
    assert result.exit_code == 2
    assert "несколько WB sid" in result.stderr
    assert "--sid S1" in result.stderr and "--sid S2" in result.stderr
    assert api.calls == []


# 7. Явный --sid работает НАПРЯМУЮ по этому sid, даже если кэш клиента его
#    не знает (wb-loader-app keyed by sid; кэш sl_wb_sids может отставать).
def test_explicit_sid_operates_directly(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", wlr._RESUME_PATH): {"resumed": 1, "items": []}}  # pyright: ignore[reportPrivateUsage]
    )
    _patch(monkeypatch, api=api)  # default cands: client 42, sids ["S1"] — без "SX"
    result = runner.invoke(_cmd(), ["42", "wbAnalytics", "--sid", "SX"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {"filter": {"sid": "SX", "loader": "wbAnalytics"}}


# 8. Неоднозначный селектор (>1 client_id) → просит --client-id.
def test_ambiguous_selector_needs_client_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(
        monkeypatch,
        api=None,
        candidates=[
            {"client_id": 1, "server": "sl-2", "title": "A", "sids": []},
            {"client_id": 2, "server": "sl-2", "title": "B", "sids": []},
        ],
    )
    result = runner.invoke(_cmd(), ["VAGUE"])
    assert result.exit_code == 2
    assert "--client-id" in result.stderr
    assert "client_id=1" in result.stderr and "client_id=2" in result.stderr


# 9. ResolveError → список кандидатов.
def test_resolve_error_lists_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    exc = ResolveError("nothing matched", candidates=[{"client_id": 7, "server": "sl-3"}])
    _patch(monkeypatch, api=None, resolve_exc=exc)
    result = runner.invoke(_cmd(), ["ZZZ"])
    assert result.exit_code == 2
    assert "nothing matched" in result.stderr
    assert "client_id=7" in result.stderr


# 10. --print → curl офлайн (sid из кэша), SlApi НЕ вызывается.
def test_print_emits_resume_curl(monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _patch(monkeypatch, api=None)  # from_env не подменён → вызов = AssertionError
    result = runner.invoke(_cmd(), ["42", "wbAnalytics", "--print"])
    assert result.exit_code == 0, result.output
    assert "TOKEN=$(mpu api get-token)" in result.output
    assert wlr._RESUME_PATH in result.output  # pyright: ignore[reportPrivateUsage]
    assert '"sid": "S1"' in result.output
    assert clip and "curl -sS -X POST" in clip[0]


# 11. --print SHOW-режим → curl на /find.
def test_print_show_mode_curl_find(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch(monkeypatch, api=None)
    result = runner.invoke(_cmd(), ["42", "--print"])
    assert result.exit_code == 0, result.output
    assert wlr._FIND_PATH in result.output  # pyright: ignore[reportPrivateUsage]
    assert wlr._RESUME_PATH not in result.output  # pyright: ignore[reportPrivateUsage]


# 12. resume 403 → подсказка про support_write+.
def test_resume_forbidden_403(monkeypatch: pytest.MonkeyPatch) -> None:
    from mpu.lib.slapi import SlApiError

    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {"data": []},  # pyright: ignore[reportPrivateUsage]
            ("POST", wlr._RESUME_PATH): SlApiError(  # pyright: ignore[reportPrivateUsage]
                "forbidden", status=403, body="role required"
            ),
        }
    )
    _patch(monkeypatch, api=api)
    result = runner.invoke(_cmd(), ["42", "wbAnalytics"])
    assert result.exit_code == 1
    assert "support_write" in result.stderr


# 13. --client-id override: резолв всё равно идёт (sids из кэша), клиент — из флага.
def test_client_id_override_picks_from_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", wlr._FIND_PATH): {"data": []}})  # pyright: ignore[reportPrivateUsage]
    _patch(
        monkeypatch,
        api=api,
        candidates=[
            {"client_id": 1, "server": "sl-2", "sids": ["A1"]},
            {"client_id": 99, "server": "sl-2", "sids": ["B9"]},
        ],
    )
    result = runner.invoke(_cmd(), ["anything", "--client-id", "99"])
    assert result.exit_code == 0, result.output
    assert '"client_id": 99' in result.output
    assert '"sid": "B9"' in result.output


# 14. sid из селектора (точное совпадение) при нескольких sid — не требует --sid.
def test_sid_from_selector_exact(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi({("POST", wlr._FIND_PATH): {"data": []}})  # pyright: ignore[reportPrivateUsage]
    _patch(
        monkeypatch,
        api=api,
        candidates=[{"client_id": 42, "server": "sl-2", "sids": ["AAA", "BBB"]}],
    )
    result = runner.invoke(_cmd(), ["AAA"])
    assert result.exit_code == 0, result.output
    assert '"sid": "AAA"' in result.output


_SHARED_SID = "57fc96d1-aadb-543d-976b-3a541ea2c3e5"


# 16. Селектор сам — полный sid, общий у клиентов на РАЗНЫХ серверах:
#     резолв клиента неоднозначен, но SHOW по sid идёт напрямую (без --client-id).
def test_full_sid_selector_bypasses_ambiguous_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {  # pyright: ignore[reportPrivateUsage]
                "data": [{"sid": _SHARED_SID, "loader": "wbAnalytics"}]
            }
        }
    )
    _patch(
        monkeypatch,
        api=api,
        resolve_exc=ResolveError(
            "ambiguous selector — 5 candidates on different servers",
            candidates=[
                {"client_id": 1519, "server": "sl-7"},
                {"client_id": 1541, "server": "sl-4"},
            ],
        ),
    )
    result = runner.invoke(_cmd(), [_SHARED_SID])
    assert result.exit_code == 0, result.output
    assert f'"sid": "{_SHARED_SID}"' in result.output
    assert '"loader": "wbAnalytics"' in result.output
    # client_id — best-effort из кэша (оба клиента, делящих кабинет).
    assert "1519" in result.output and "1541" in result.output
    find = next(c for c in api.calls if c[1] == wlr._FIND_PATH)  # pyright: ignore[reportPrivateUsage]
    assert find[2] == {"filter": {"sid": _SHARED_SID}}
    assert all(c[1] != wlr._RESUME_PATH for c in api.calls)  # pyright: ignore[reportPrivateUsage]


# 17. Полный sid + loader: resume идёт по sid напрямую несмотря на
#     неоднозначный резолв клиента (кейс bash-скрипта).
def test_full_sid_selector_resume(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", wlr._RESUME_PATH): {"resumed": 1, "items": []}}  # pyright: ignore[reportPrivateUsage]
    )
    _patch(
        monkeypatch,
        api=api,
        resolve_exc=ResolveError(
            "ambiguous", candidates=[{"client_id": 1519}, {"client_id": 1541}]
        ),
    )
    result = runner.invoke(_cmd(), [_SHARED_SID, "wbAnalytics"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {"filter": {"sid": _SHARED_SID, "loader": "wbAnalytics"}}
    assert all(c[1] != wlr._FIND_PATH for c in api.calls)  # pyright: ignore[reportPrivateUsage]


# 18. Клиент-селектор, несколько sid, SHOW-режим → показать blocked по ВСЕМ sid
#     (раньше падал «несколько WB sid»; кейс `mpu api wb-loader-resume 1541`).
def test_show_mode_multi_sid_iterates_all(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {  # pyright: ignore[reportPrivateUsage]
                "data": [{"sid": "?", "loader": "wbAnalytics"}]
            }
        }
    )
    _patch(
        monkeypatch,
        api=api,
        candidates=[{"client_id": 1541, "server": "sl-2", "sids": ["S1", "S2"]}],
    )
    result = runner.invoke(_cmd(), ["1541"])
    assert result.exit_code == 0, result.output
    assert '"sids"' in result.output
    assert '"sid": "S1"' in result.output and '"sid": "S2"' in result.output
    find_calls = [c for c in api.calls if c[1] == wlr._FIND_PATH]  # pyright: ignore[reportPrivateUsage]
    assert {c[2]["filter"]["sid"] for c in find_calls} == {"S1", "S2"}
    assert all(c[1] != wlr._RESUME_PATH for c in api.calls)  # pyright: ignore[reportPrivateUsage]


# 19. Полный sid, кэш пуст (резолв ничего не нашёл) → client_id null, но
#     find по sid всё равно идёт.
def test_full_sid_selector_empty_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", wlr._FIND_PATH): {"data": []}}  # pyright: ignore[reportPrivateUsage]
    )
    _patch(
        monkeypatch,
        api=api,
        resolve_exc=ResolveError("nothing matched", candidates=[]),
    )
    result = runner.invoke(_cmd(), [_SHARED_SID])
    assert result.exit_code == 0, result.output
    assert '"client_id": null' in result.output
    assert f'"sid": "{_SHARED_SID}"' in result.output


# 20. client_id-селектор + --sid + loader → resume по sid напрямую, лейбл
#     клиента best-effort из кэша.
def test_client_id_plus_sid_resume(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {("POST", wlr._RESUME_PATH): {"resumed": 1, "items": []}}  # pyright: ignore[reportPrivateUsage]
    )
    _patch(
        monkeypatch,
        api=api,
        candidates=[{"client_id": 1541, "server": "sl-4", "sids": [_SHARED_SID, "other"]}],
    )
    result = runner.invoke(_cmd(), ["1541", "--sid", _SHARED_SID, "wbAnalytics"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {"filter": {"sid": _SHARED_SID, "loader": "wbAnalytics"}}
    assert '"client_id": 1541' in result.output


# 21. Явный --sid у multi-sid клиента в SHOW-режиме → только этот sid
#     (не все sid клиента).
def test_explicit_sid_narrows_show_for_multi_sid(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._FIND_PATH): {  # pyright: ignore[reportPrivateUsage]
                "data": [{"sid": "S2", "loader": "wbAnalytics"}]
            }
        }
    )
    _patch(
        monkeypatch,
        api=api,
        candidates=[{"client_id": 1541, "server": "sl-4", "sids": ["S1", "S2"]}],
    )
    result = runner.invoke(_cmd(), ["1541", "--sid", "S2"])
    assert result.exit_code == 0, result.output
    find_calls = [c for c in api.calls if c[1] == wlr._FIND_PATH]  # pyright: ignore[reportPrivateUsage]
    assert [c[2]["filter"]["sid"] for c in find_calls] == ["S2"]
    assert '"sid": "S2"' in result.output
    assert '"sids"' not in result.output  # одиночная форма, не массив


# 15. sid из селектора (однозначный substring).
def test_sid_from_selector_substring(monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeSlApi(
        {
            ("POST", wlr._RESUME_PATH): {  # pyright: ignore[reportPrivateUsage]
                "resumed": 1,
                "items": [],
            },
            ("POST", wlr._FIND_PATH): {"data": []},  # pyright: ignore[reportPrivateUsage]
        }
    )
    _patch(
        monkeypatch,
        api=api,
        candidates=[
            {
                "client_id": 42,
                "server": "sl-2",
                "sids": ["168587da-6853-4576-b953-9cd744a33772", "ffffffff-0000"],
            }
        ],
    )
    result = runner.invoke(_cmd(), ["168587da", "wbAnalytics"])
    assert result.exit_code == 0, result.output
    resume = next(c for c in api.calls if c[1] == wlr._RESUME_PATH)  # pyright: ignore[reportPrivateUsage]
    assert resume[2] == {
        "filter": {"sid": "168587da-6853-4576-b953-9cd744a33772", "loader": "wbAnalytics"}
    }
