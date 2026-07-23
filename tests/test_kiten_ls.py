"""Тесты `mpu kiten ls` — выборка карточек и фильтры.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
import typer

from kiten_fakes import (
    FakeKaitenClient,
    card_payload,
    install_client,
    install_env,
    patch_columns_cache,
    patch_spaces_cache,
    runner,
    user_payload,
)
from mpu.commands.kiten import (
    LsFilters,
    app,
    build_updated_window,
    resolve_ls_filters,
)
from mpu.lib.kaiten import (
    build_cards_query,
)


def _env(values: dict[str, str]) -> Callable[[str], str | None]:
    """env_get-callback поверх словаря (для чистого resolve_ls_filters)."""
    return lambda name: values.get(name)


# ── build_cards_query ──────────────────────────────────────────────────────────


def test_build_cards_query_omits_none_filters() -> None:
    query = build_cards_query(member_ids="10", limit=100, offset=0)
    assert query == {"limit": "100", "offset": "0", "member_ids": "10"}
    # None-фильтры не должны попасть в запрос.
    assert "condition" not in query
    assert "states" not in query
    assert "space_id" not in query
    assert "board_id" not in query
    assert "updated_after" not in query
    assert "updated_before" not in query


def test_build_cards_query_includes_all_filters() -> None:
    query = build_cards_query(
        member_ids="10",
        condition=2,
        states="1,2",
        space_id=5,
        board_id=7,
        limit=100,
        offset=200,
    )
    assert query == {
        "limit": "100",
        "offset": "200",
        "member_ids": "10",
        "condition": "2",
        "states": "1,2",
        "space_id": "5",
        "board_id": "7",
    }


def test_build_cards_query_includes_updated_window() -> None:
    query = build_cards_query(
        member_ids="10",
        updated_after="2026-05-01T00:00:00Z",
        updated_before="2026-06-04T23:59:59Z",
    )
    assert query["updated_after"] == "2026-05-01T00:00:00Z"
    assert query["updated_before"] == "2026-06-04T23:59:59Z"


# ── resolve_ls_filters: precedence CLI > env > дефолт ───────────────────────────


def test_resolve_defaults_no_cli_no_env() -> None:
    filters = resolve_ls_filters(
        env_get=_env({}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
    )
    assert filters == LsFilters(condition=1, states=None, space_id=None, board_id=None)


def test_resolve_env_applied_when_no_cli() -> None:
    filters = resolve_ls_filters(
        env_get=_env(
            {
                "KITEN_LS_CONDITION": "2",
                "KITEN_LS_STATES": "1,2",
                "KITEN_LS_SPACE_ID": "5",
                "KITEN_LS_BOARD_ID": "7",
            }
        ),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
    )
    assert filters == LsFilters(condition=2, states="1,2", space_id=5, board_id=7)


def test_resolve_cli_overrides_env() -> None:
    filters = resolve_ls_filters(
        env_get=_env(
            {
                "KITEN_LS_CONDITION": "1",
                "KITEN_LS_STATES": "1,2",
                "KITEN_LS_SPACE_ID": "5",
                "KITEN_LS_BOARD_ID": "7",
            }
        ),
        cli_archived=True,  # → condition=2, выше env
        cli_state="done",  # → "3", выше env states
        cli_space=99,
        cli_board=88,
    )
    assert filters == LsFilters(condition=2, states="3", space_id=99, board_id=88)


@pytest.mark.parametrize(
    ("cli_state", "code"), [("queued", "1"), ("in-progress", "2"), ("done", "3")]
)
def test_resolve_state_name_to_code(cli_state: str, code: str) -> None:
    filters = resolve_ls_filters(
        env_get=_env({}),
        cli_archived=False,
        cli_state=cli_state,
        cli_space=None,
        cli_board=None,
    )
    assert filters.states == code


def test_resolve_blank_env_treated_as_unset() -> None:
    filters = resolve_ls_filters(
        env_get=_env({"KITEN_LS_STATES": "  ", "KITEN_LS_SPACE_ID": ""}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
    )
    assert filters.states is None
    assert filters.space_id is None


# ── resolve_ls_filters(scope_all): дата → глобальный поиск, env игнорируется ────


def test_resolve_scope_all_ignores_env_and_includes_archived() -> None:
    # При scope_all env-скоуп НЕ применяется, condition=None (active + archived),
    # остальные оси пустые (глобально по всем доскам).
    filters = resolve_ls_filters(
        env_get=_env(
            {
                "KITEN_LS_CONDITION": "1",
                "KITEN_LS_STATES": "1,2",
                "KITEN_LS_BOARD_ID": "7",
                "KITEN_LS_LANE_ID": "9",
                "KITEN_LS_COLUMN_ID": "11",
            }
        ),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
        scope_all=True,
    )
    assert filters == LsFilters(
        condition=None, states=None, space_id=None, board_id=None, lane_id=None, column_id=None
    )


def test_resolve_scope_all_archived_restricts_to_archived() -> None:
    # Явный --archived в глобальном режиме сужает до архива (condition=2).
    filters = resolve_ls_filters(
        env_get=_env({}),
        cli_archived=True,
        cli_state=None,
        cli_space=None,
        cli_board=None,
        scope_all=True,
    )
    assert filters.condition == 2


def test_resolve_scope_all_explicit_cli_still_narrows() -> None:
    # «если в фильтре указано иное»: явные CLI-оси сужают даже в глобальном режиме,
    # но env по-прежнему игнорируется.
    filters = resolve_ls_filters(
        env_get=_env({"KITEN_LS_BOARD_ID": "7", "KITEN_LS_LANE_ID": "9"}),
        cli_archived=False,
        cli_state="done",
        cli_space=5,
        cli_board=88,
        cli_lane=900,
        cli_column=None,
        scope_all=True,
    )
    assert filters.space_id == 5  # из CLI
    assert filters.board_id == 88  # из CLI
    assert filters.lane_id == 900  # из CLI
    assert filters.states == "3"  # --state done
    assert filters.column_id is None  # env KITEN_LS_* НЕ подмешан
    assert filters.condition is None  # без --archived → и активные, и архивные


# ── build_updated_window: YYYY-MM-DD → (updated_after, updated_before) ──────────


def test_build_updated_window_both_bounds() -> None:
    after, before = build_updated_window("2026-05-01", "2026-06-04")
    # from → начало дня, to → конец дня (инклюзивно), UTC.
    assert after == "2026-05-01T00:00:00Z"
    assert before == "2026-06-04T23:59:59Z"


def test_build_updated_window_only_from() -> None:
    after, before = build_updated_window("2026-05-01", None)
    assert after == "2026-05-01T00:00:00Z"
    assert before is None


def test_build_updated_window_only_to() -> None:
    after, before = build_updated_window(None, "2026-06-04")
    assert after is None
    assert before == "2026-06-04T23:59:59Z"


def test_build_updated_window_none_stays_none() -> None:
    # без обоих флагов — обе оси не фильтруются (ls работает как раньше).
    assert build_updated_window(None, None) == (None, None)


def test_build_updated_window_empty_string_treated_as_unset() -> None:
    # пустая строка трактуется как «не задано» (как blank env в _env_str), не ошибка.
    assert build_updated_window("", "") == (None, None)


@pytest.mark.parametrize("bad", ["2026-13-01", "2026-06-31", "foo", "01-05-2026"])
def test_build_updated_window_invalid_date_raises(bad: str) -> None:
    with pytest.raises(typer.BadParameter):
        build_updated_window(bad, None)
    with pytest.raises(typer.BadParameter):
        build_updated_window(None, bad)


# ── ls ──────────────────────────────────────────────────────────────────────────


def test_ls_json(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42)]))
    res = runner.invoke(app, ["ls", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload[0]["id"] == 42
    assert payload[0]["state"] == "in progress"
    assert payload[0]["url"] == "https://btlz.kaiten.ru/42"


def test_ls_empty_table(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), cards=[]))
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 0, res.stderr
    assert "(нет карточек)" in res.output


def test_ls_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(
        monkeypatch,
        FakeKaitenClient(user=user_payload(), cards=[card_payload(42), card_payload(43)]),
    )
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 0, res.stderr
    assert "(2 cards)" in res.output


def test_ls_only_url(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42)]))
    res = runner.invoke(app, ["ls", "--only-url"])
    assert res.exit_code == 0, res.stderr
    assert "[Card 42](https://btlz.kaiten.ru/42)" in res.output


def test_ls_md_table(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42)]))
    res = runner.invoke(app, ["ls", "--md"])
    assert res.exit_code == 0, res.stderr
    assert "| ID | STATE | COLUMN | DUE | TITLE | URL |" in res.output
    assert "https://btlz.kaiten.ru/42" in res.output


def test_ls_format_template(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, [(10, "Очередь")])
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42)]))
    res = runner.invoke(app, ["ls", "--format", "{id}|{state}|{column}|{due}"])
    assert res.exit_code == 0, res.stderr
    assert "42|in progress|Очередь|2026-06-30" in res.output


def test_ls_filters_passed_to_list_cards(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), cards=[])
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app,
        [
            "ls",
            "--json",
            "--space",
            "5",
            "--board",
            "7",
            "--lane",
            "9",
            "--column",
            "11",
            "--state",
            "done",
        ],
    )
    assert res.exit_code == 0, res.stderr
    assert fake.list_cards_kwargs["member_ids"] == "42"
    assert fake.list_cards_kwargs["condition"] == 1
    assert fake.list_cards_kwargs["states"] == "3"
    assert fake.list_cards_kwargs["space_id"] == 5
    assert fake.list_cards_kwargs["board_id"] == 7
    assert fake.list_cards_kwargs["lane_id"] == 9
    assert fake.list_cards_kwargs["column_id"] == 11


def test_ls_date_window_scope_all(monkeypatch: pytest.MonkeyPatch) -> None:
    # Дата → глобальный режим: env-скоуп игнорируется, condition=None, окно проставлено.
    install_env(monkeypatch, {"KITEN_LS_BOARD_ID": "7"})
    fake = FakeKaitenClient(user=user_payload(), cards=[])
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app, ["ls", "--json", "--date-from", "2026-05-01", "--date-to", "2026-06-04"]
    )
    assert res.exit_code == 0, res.stderr
    assert fake.list_cards_kwargs["condition"] is None
    assert fake.list_cards_kwargs["board_id"] is None
    assert fake.list_cards_kwargs["updated_after"] == "2026-05-01T00:00:00Z"
    assert fake.list_cards_kwargs["updated_before"] == "2026-06-04T23:59:59Z"


def test_ls_space_substring_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    patch_spaces_cache(monkeypatch, [(5, "10X Support")])
    fake = FakeKaitenClient(user=user_payload(), cards=[])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ls", "--json", "--space", "Support"])
    assert res.exit_code == 0, res.stderr
    assert fake.list_cards_kwargs["space_id"] == 5


def test_ls_bad_space_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    patch_spaces_cache(monkeypatch, [])
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["ls", "--space", "Nope"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr


def test_ls_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), fail={"list_cards"}))
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 1
    assert "ls: kaiten error" in res.stderr


# ── ls --format {column_mapped}: KITEN_COLUMN_MAP (валидный / битый / не-объект) ─


def test_ls_format_column_mapped_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {"KITEN_COLUMN_MAP": '{"10": "DONE"}'})
    patch_columns_cache(monkeypatch, [(10, "Очередь")])
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42, column_id=10)])
    )
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "DONE" in res.output


def test_ls_format_column_map_bad_json(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {"KITEN_COLUMN_MAP": "{not json"})
    patch_columns_cache(monkeypatch, [(10, "Очередь")])
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42, column_id=10)])
    )
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "некорректный JSON в KITEN_COLUMN_MAP" in res.stderr
    assert "Очередь" in res.output  # фолбэк на сырое имя колонки


def test_ls_format_column_map_not_object(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {"KITEN_COLUMN_MAP": "[]"})
    patch_columns_cache(monkeypatch, [(10, "Очередь")])
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(42, column_id=10)])
    )
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "должен быть JSON-объектом" in res.stderr
