"""Тесты `mpu kiten spaces|boards|lanes|columns|roles` — справочник и completion.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
import typer

from kiten_fakes import (
    install_env,
    patch_columns_disc,
    patch_discover,
    patch_lanes,
    patch_spaces_cache,
    runner,
    seed_link,
)
from mpu.commands.kiten import (
    _board_id_from_ctx,  # pyright: ignore[reportPrivateUsage]
    _complete_board,  # pyright: ignore[reportPrivateUsage]
    _complete_column,  # pyright: ignore[reportPrivateUsage]
    _complete_lane,  # pyright: ignore[reportPrivateUsage]
    _complete_space,  # pyright: ignore[reportPrivateUsage]
    app,
    resolve_ls_filters,
)
from mpu.lib import kaiten_cache
from mpu.lib.kaiten import (
    KaitenBoard,
    KaitenColumn,
    KaitenLane,
    KaitenSpace,
    build_cards_query,
    parse_boards_of_space,
    parse_column,
    parse_lane,
    parse_space,
)
from mpu.lib.kaiten_cache import (
    filter_refs,
    resolve_ref,
)


def _env(values: dict[str, str]) -> Callable[[str], str | None]:
    """env_get-callback поверх словаря (для чистого resolve_ls_filters)."""
    return lambda name: values.get(name)


# ── parse_space / parse_boards_of_space ────────────────────────────────────────


def test_parse_space_full() -> None:
    space = parse_space({"id": 286794, "title": "10Х Support", "archived": False})
    assert space.id == 286794
    assert space.title == "10Х Support"
    assert space.archived is False


def test_parse_space_missing_fields() -> None:
    space = parse_space({"id": 1})
    assert space.id == 1
    assert space.title == ""
    assert space.archived is False


def test_parse_boards_of_space_extracts_embedded() -> None:
    raw = {
        "id": 286794,
        "boards": [
            {"id": 671731, "title": "10X Support", "space_id": 286794},
            {"id": 671732, "title": "Backlog", "space_id": 286794},
        ],
    }
    boards = parse_boards_of_space(raw)
    assert [(b.id, b.title, b.space_id) for b in boards] == [
        (671731, "10X Support", 286794),
        (671732, "Backlog", 286794),
    ]


def test_parse_boards_of_space_falls_back_to_space_id() -> None:
    # board без своего space_id наследует id родительского space.
    boards = parse_boards_of_space({"id": 500, "boards": [{"id": 9, "title": "B"}]})
    assert boards[0].space_id == 500


def test_parse_boards_of_space_no_boards_key() -> None:
    assert parse_boards_of_space({"id": 1}) == []


# ── filter_refs (completion: ID-префикс или подстрока title) ────────────────────

_REF_ROWS = [(286794, "10Х Support"), (286791, "Naparad WB"), (368441, "Keris WB")]


def test_filter_refs_by_id_prefix() -> None:
    assert filter_refs("2867", _REF_ROWS) == [("286794", "10Х Support"), ("286791", "Naparad WB")]


def test_filter_refs_by_title_substring_casefold() -> None:
    assert filter_refs("wb", _REF_ROWS) == [("286791", "Naparad WB"), ("368441", "Keris WB")]


def test_filter_refs_empty_incomplete_returns_all() -> None:
    assert filter_refs("", _REF_ROWS) == [
        ("286794", "10Х Support"),
        ("286791", "Naparad WB"),
        ("368441", "Keris WB"),
    ]


def test_filter_refs_returns_id_value_title_help() -> None:
    # value = str(id) (парсится в int), help = title.
    assert filter_refs("Keris", _REF_ROWS) == [("368441", "Keris WB")]


# ── resolve_ref (ID или подстрока названия → int; коллизии → ValueError) ─────────


def test_resolve_ref_numeric_passthrough_ignores_rows() -> None:
    # чисто-цифровой ref трактуется как ID, работает и при пустом кэше.
    assert resolve_ref("99999", [], kind="space") == 99999


def test_resolve_ref_unique_substring() -> None:
    assert resolve_ref("Naparad", _REF_ROWS, kind="space") == 286791


def test_resolve_ref_casefold() -> None:
    assert resolve_ref("keris", _REF_ROWS, kind="space") == 368441


def test_resolve_ref_no_match_raises() -> None:
    with pytest.raises(ValueError, match="не найден"):
        resolve_ref("Nonexistent", _REF_ROWS, kind="space")


def test_resolve_ref_ambiguous_lists_candidates() -> None:
    with pytest.raises(ValueError, match="неоднозначен") as exc:
        resolve_ref("WB", _REF_ROWS, kind="space")
    # в сообщении — оба кандидата для дизамбигуации.
    assert "286791" in str(exc.value)
    assert "368441" in str(exc.value)


# ── lanes: parse_lane / build_cards_query(lane_id) / resolve_ls_filters(lane) ───


def test_parse_lane_full() -> None:
    lane = parse_lane({"id": 844615, "board_id": 671731, "title": "Support"})
    assert lane.id == 844615
    assert lane.board_id == 671731
    assert lane.title == "Support"


def test_build_cards_query_lane_is_singular() -> None:
    # фильтр дорожки в API — `lane_id` (ед.ч.), НЕ `lane_ids`.
    query = build_cards_query(member_ids="10", lane_id=844615)
    assert query["lane_id"] == "844615"
    assert "lane_ids" not in query


def test_resolve_lane_env_applied_when_no_cli() -> None:
    filters = resolve_ls_filters(
        env_get=_env({"KITEN_LS_LANE_ID": "844615"}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
    )
    assert filters.lane_id == 844615


def test_resolve_lane_cli_overrides_env() -> None:
    filters = resolve_ls_filters(
        env_get=_env({"KITEN_LS_LANE_ID": "844615"}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
        cli_lane=900000,
    )
    assert filters.lane_id == 900000


def test_resolve_cli_overrides_only_its_own_axis() -> None:
    # Ключевое требование: один CLI-флаг переопределяет ТОЛЬКО свою ось,
    # остальные оси остаются из .env.
    env_all = _env(
        {
            "KITEN_LS_CONDITION": "2",
            "KITEN_LS_STATES": "1,2",
            "KITEN_LS_SPACE_ID": "5",
            "KITEN_LS_BOARD_ID": "7",
            "KITEN_LS_LANE_ID": "9",
        }
    )
    filters = resolve_ls_filters(
        env_get=env_all,
        cli_archived=False,
        cli_state=None,
        cli_space=99,  # переопределяем ТОЛЬКО space
        cli_board=None,
        cli_lane=None,
    )
    assert filters.space_id == 99  # из CLI
    assert filters.board_id == 7  # из .env, не сброшено
    assert filters.lane_id == 9  # из .env, не сброшено
    assert filters.states == "1,2"  # из .env
    assert filters.condition == 2  # из .env


# ── columns: parse_column / build_cards_query(column_id) / resolve_ls_filters ───


def test_parse_column_full() -> None:
    col = parse_column({"id": 2417329, "board_id": 671731, "title": "Готово"})
    assert col.id == 2417329
    assert col.board_id == 671731
    assert col.title == "Готово"


def test_build_cards_query_column_id() -> None:
    query = build_cards_query(member_ids="10", column_id=2417329)
    assert query["column_id"] == "2417329"


def test_resolve_column_env_and_cli() -> None:
    # env применяется без cli...
    env_only = resolve_ls_filters(
        env_get=_env({"KITEN_LS_COLUMN_ID": "2417329"}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
    )
    assert env_only.column_id == 2417329
    # ...cli переопределяет env (только свою ось).
    cli_over = resolve_ls_filters(
        env_get=_env({"KITEN_LS_COLUMN_ID": "2417329", "KITEN_LS_LANE_ID": "844615"}),
        cli_archived=False,
        cli_state=None,
        cli_space=None,
        cli_board=None,
        cli_column=999,
    )
    assert cli_over.column_id == 999  # из CLI
    assert cli_over.lane_id == 844615  # из .env, не сброшено


# ── resolve_ref: точное совпадение названия в приоритете над подстрокой ──────────


def test_resolve_ref_exact_wins_over_substring() -> None:
    # «Готово» резолвится в точную колонку, хотя есть «Готово к код-ревью» и т.п.
    rows = [(1, "Готово к код-ревью"), (2, "Готово к тестированию QA"), (3, "Готово")]
    assert resolve_ref("Готово", rows, kind="column") == 3


def test_resolve_ref_exact_casefold() -> None:
    assert resolve_ref("готово", [(3, "Готово")], kind="column") == 3


def test_resolve_ref_duplicate_exact_is_ambiguous() -> None:
    # два одинаковых точных названия → неоднозначно (нельзя выбрать).
    with pytest.raises(ValueError, match="неоднозначен"):
        resolve_ref("Готово", [(3, "Готово"), (4, "Готово")], kind="column")


# ── spaces / boards / lanes / columns ───────────────────────────────────────────


def test_spaces_json(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, spaces=[KaitenSpace(id=5, title="Support", archived=False)])
    res = runner.invoke(app, ["spaces", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 5, "title": "Support", "archived": False}]


def test_spaces_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, spaces=[KaitenSpace(id=5, title="Support", archived=False)])
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 0, res.stderr
    assert "(1 spaces)" in res.output


def test_spaces_hides_archived_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(
        monkeypatch,
        spaces=[
            KaitenSpace(id=5, title="Active", archived=False),
            KaitenSpace(id=6, title="Old", archived=True),
        ],
    )
    res = runner.invoke(app, ["spaces", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [s["id"] for s in payload] == [5]
    res_all = runner.invoke(app, ["spaces", "--all", "--json"])
    payload_all: list[dict[str, Any]] = json.loads(res_all.output)
    assert [s["id"] for s in payload_all] == [5, 6]


def test_spaces_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, spaces=[])
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 0, res.stderr
    assert "(нет пространств)" in res.output


def test_spaces_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, error="kaiten: boom")
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 1
    assert "spaces: kaiten error: kaiten: boom" in res.stderr


def test_boards_json(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 7, "space_id": 5, "title": "B"}]


def test_boards_space_filter_numeric(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(
        monkeypatch,
        boards=[
            KaitenBoard(id=7, space_id=5, title="B5"),
            KaitenBoard(id=8, space_id=6, title="B6"),
        ],
    )
    res = runner.invoke(app, ["boards", "--json", "--space", "5"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [b["id"] for b in payload] == [7]


def test_boards_space_substring(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_spaces_cache(monkeypatch, [(5, "Support")])
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards", "--json", "--space", "Supp"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [b["id"] for b in payload] == [7]


def test_boards_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[])
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 0, res.stderr
    assert "(нет досок)" in res.output


def test_boards_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, error="kaiten: down")
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 1
    assert "boards: kaiten error" in res.stderr


def test_lanes_json(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="Support")])
    res = runner.invoke(app, ["lanes", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 9, "board_id": 7, "title": "Support"}]


def test_lanes_board_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(
        monkeypatch,
        boards=[
            KaitenBoard(id=7, space_id=5, title="B7"),
            KaitenBoard(id=8, space_id=5, title="B8"),
        ],
    )
    patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="L")])
    res = runner.invoke(app, ["lanes", "--json", "--board", "7"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 9, "board_id": 7, "title": "L"}]


def test_lanes_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_lanes(monkeypatch, lanes=[])
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 0, res.stderr
    assert "(нет дорожек)" in res.output


def test_lanes_discover_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, error="kaiten: down")
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 1
    assert "lanes: kaiten error" in res.stderr


def test_lanes_lanes_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_lanes(monkeypatch, error="kaiten: lane boom")
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 1
    assert "lanes: kaiten error: kaiten: lane boom" in res.stderr


def test_columns_json(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_columns_disc(monkeypatch, columns=[KaitenColumn(id=30, board_id=7, title="Готово")])
    res = runner.invoke(app, ["columns", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 30, "board_id": 7, "title": "Готово"}]


def test_columns_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_columns_disc(monkeypatch, error="kaiten: col boom")
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 1
    assert "columns: kaiten error: kaiten: col boom" in res.stderr


# ── table-smoke (rich-вывод непустых таблиц boards/lanes/columns/field ls) ───────


def test_boards_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 0, res.stderr
    assert "(1 boards)" in res.output


def test_lanes_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="L")])
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 0, res.stderr
    assert "(1 lanes)" in res.output


def test_columns_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_columns_disc(monkeypatch, columns=[KaitenColumn(id=30, board_id=7, title="Готово")])
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 0, res.stderr
    assert "(1 columns)" in res.output


def test_columns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    patch_columns_disc(monkeypatch, columns=[])
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 0, res.stderr
    assert "(нет колонок)" in res.output


def test_field_ls_table_smoke(db_path: Path) -> None:
    seed_link(100, "mr", "https://mr/1")
    res = runner.invoke(app, ["field", "ls"])
    assert res.exit_code == 0, res.stderr
    assert "https://mr/1" in res.output


# ── completion-хелперы (best-effort, при ошибке → []) ────────────────────────────


def test_complete_space_filters_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_spaces_cache(monkeypatch, [(5, "Support"), (6, "Backlog")])
    assert _complete_space("Sup") == [("5", "Support")]


def test_complete_space_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> list[tuple[int, str]]:
        raise RuntimeError("cache down")

    monkeypatch.setattr(kaiten_cache, "cached_spaces", _boom)
    assert _complete_space("x") == []


def test_complete_board_scoped_by_space(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_spaces_cache(monkeypatch, [(5, "Support")])

    def _boards(space_id: int | None = None) -> list[tuple[int, str]]:
        assert space_id == 5
        return [(7, "Board")]

    monkeypatch.setattr(kaiten_cache, "cached_boards", _boards)
    ctx = cast("typer.Context", _FakeCtx({"space": "Support"}))
    assert _complete_board(ctx, "") == [("7", "Board")]


def test_complete_lane_and_column_use_board_ctx(monkeypatch: pytest.MonkeyPatch) -> None:
    def _lanes(board_id: int | None = None) -> list[tuple[int, str]]:
        return [(9, "Lane")]

    def _columns(board_id: int | None = None) -> list[tuple[int, str]]:
        return [(30, "Готово")]

    monkeypatch.setattr(kaiten_cache, "cached_lanes", _lanes)
    monkeypatch.setattr(kaiten_cache, "cached_columns", _columns)
    ctx = cast("typer.Context", _FakeCtx({"board": "7"}))
    assert _complete_lane(ctx, "") == [("9", "Lane")]
    assert _complete_column(ctx, "Гот") == [("30", "Готово")]


def test_board_id_from_ctx_explicit_board(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})

    def _boards(space_id: int | None = None) -> list[tuple[int, str]]:
        return [(7, "Board")]

    monkeypatch.setattr(kaiten_cache, "cached_boards", _boards)
    ctx = cast("typer.Context", _FakeCtx({"board": "Board"}))
    assert _board_id_from_ctx(ctx) == 7


def test_board_id_from_ctx_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {"KITEN_LS_BOARD_ID": "7"})
    ctx = cast("typer.Context", _FakeCtx({"board": None}))
    assert _board_id_from_ctx(ctx) == 7


class _FakeCtx:
    """Минимальный stand-in для typer.Context: только `params` для completion-хелперов."""

    def __init__(self, params: dict[str, object]) -> None:
        self.params = params


# ════════════════════════════════════════════════════════════════════════════════
# Учёт времени (`mpu kiten time`): чистые хелперы + CLI
# ════════════════════════════════════════════════════════════════════════════════
