"""Unit-тесты общих хелперов `commands/_wb_loader.py`."""

from __future__ import annotations

import pytest

from mpu.commands import _wb_loader as wl
from mpu.lib.resolver import ResolveError

_SID = "57fc96d1-aadb-543d-976b-3a541ea2c3e5"


def test_looks_like_sid() -> None:
    assert wl.looks_like_sid(_SID)
    assert not wl.looks_like_sid("42")
    assert not wl.looks_like_sid("ТигрыИгры")
    assert not wl.looks_like_sid(_SID[:-1])  # обрезанный


def test_loader_path() -> None:
    assert (
        wl.loader_path("S1", "adv-normquery-stats", "reset")
        == "/admin/wb-loader/loaders/S1/adv-normquery-stats/v1/reset"
    )


def test_entities_lists() -> None:
    assert "adv-normquery-stats" in wl.LOADER_ENTITIES
    assert "cards" in wl.LOADER_ENTITIES
    assert "adv-normquery-stats" in wl.FORWARD_ONLY_ENTITIES
    assert "cards" not in wl.FORWARD_ONLY_ENTITIES


def test_complete_entity() -> None:
    out = wl.complete_entity(None, None, "adv-normquery")  # pyright: ignore[reportArgumentType]
    assert "adv-normquery-stats" in out
    assert "adv-normquery-stats-by-dates" in out
    assert all(e.startswith("adv-normquery") for e in out)


def test_sid_from_selector() -> None:
    sids = ["168587da-6853-4576-b953-9cd744a33772", "ffffffff-0000"]
    assert wl.sid_from_selector("168587da-6853-4576-b953-9cd744a33772", sids) == sids[0]  # точное
    assert wl.sid_from_selector("168587da", sids) == sids[0]  # однозначный substring
    assert wl.sid_from_selector("zzz", sids) is None
    assert wl.sid_from_selector("0", ["a-0", "b-0"]) is None  # неоднозначный substring


def test_pick_sid_single_and_named() -> None:
    assert wl.pick_sid("anything", ["ONE"], command="t") == "ONE"
    assert wl.pick_sid("BBB", ["AAA", "BBB"], command="t") == "BBB"


def test_pick_sid_multi_exits() -> None:
    with pytest.raises(SystemExit) as ei:
        wl.pick_sid("vague", ["AAA", "BBB"], command="t")
    assert ei.value.code == 2


def test_pick_sid_empty_exits() -> None:
    with pytest.raises(SystemExit) as ei:
        wl.pick_sid("x", [], command="t")
    assert ei.value.code == 2


def test_resolve_target_sid_explicit_sid_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    # --sid → прямой режим, resolve_server НЕ вызывается.
    def _boom(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise AssertionError("resolve_server не должен вызываться в прямом режиме")

    monkeypatch.setattr(wl, "resolve_server", _boom)
    sid, label = wl.resolve_target_sid("42", "SX", 99, command="t")
    assert sid == "SX"
    assert label == "99"


def test_resolve_target_sid_uuid_selector_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise AssertionError("resolve_server не должен вызываться для UUID-селектора")

    monkeypatch.setattr(wl, "resolve_server", _boom)
    sid, label = wl.resolve_target_sid(_SID, None, None, command="t")
    assert sid == _SID
    assert label == "?"


def test_resolve_target_sid_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 2, [{"client_id": 42, "server": "sl-2", "sids": ["S1"]}]

    monkeypatch.setattr(wl, "resolve_server", _fake)
    sid, label = wl.resolve_target_sid("42", None, None, command="t")
    assert sid == "S1"
    assert label == "42"


def test_cids_for_sid_and_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        return 2, [{"client_id": 1519}, {"client_id": 1541}]

    monkeypatch.setattr(wl, "resolve_server", _fake)
    cids = wl.cids_for_sid(_SID)
    assert cids == [1519, 1541]
    assert wl.cid_json(cids) == [1519, 1541]
    assert wl.cid_json([7]) == 7
    assert wl.cid_json([]) is None
    assert wl.cid_label(cids) == "1519,1541"
    assert wl.cid_label([]) == "?"


def test_cids_for_sid_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        raise ResolveError("nothing", candidates=None)

    monkeypatch.setattr(wl, "resolve_server", _raise)
    assert wl.cids_for_sid(_SID) == []
