"""Тесты `mpu kiten` — только чистые функции (без сети и без моков HTTP).

I/O-клиент `KaitenClient` (_request/current_user/list_cards) тестами не покрыт —
прецедент miro/slapi. Здесь: сборка query, парсинг карточки, маппинг state,
URL и precedence фильтров (CLI > env > дефолт).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import kiten as kiten_mod
from mpu.commands.kiten import (
    LsFilters,
    _board_id_from_ctx,  # pyright: ignore[reportPrivateUsage]
    _card_to_markdown,  # pyright: ignore[reportPrivateUsage]
    _complete_board,  # pyright: ignore[reportPrivateUsage]
    _complete_column,  # pyright: ignore[reportPrivateUsage]
    _complete_lane,  # pyright: ignore[reportPrivateUsage]
    _complete_space,  # pyright: ignore[reportPrivateUsage]
    _expand_all_to_owner,  # pyright: ignore[reportPrivateUsage]
    _left_neighbor_column,  # pyright: ignore[reportPrivateUsage]
    app,
    build_updated_window,
    coalesce,
    expand_all_mention,
    expand_recipients,
    parse_recipients,
    plan_field_actions,
    prepend_recipients,
    read_attachments,
    resolve_comment_text,
    resolve_ls_filters,
)
from mpu.lib import env, kaiten_cache, kaiten_links, kaiten_render, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenBoard,
    KaitenCard,
    KaitenCardDetail,
    KaitenClient,
    KaitenColumn,
    KaitenComment,
    KaitenFile,
    KaitenLane,
    KaitenMember,
    KaitenSpace,
    KaitenUser,
    build_cards_query,
    build_multipart,
    card_url,
    parse_boards_of_space,
    parse_card,
    parse_card_detail,
    parse_card_ref,
    parse_column,
    parse_comment,
    parse_custom_property,
    parse_file,
    parse_lane,
    parse_member,
    parse_space,
    state_label,
)
from mpu.lib.kaiten_cache import (
    KaitenColumnsResult,
    KaitenDiscoveryResult,
    KaitenLanesResult,
    filter_refs,
    resolve_ref,
)


def _env(values: dict[str, str]) -> Callable[[str], str | None]:
    """env_get-callback поверх словаря (для чистого resolve_ls_filters)."""
    return lambda name: values.get(name)


# ── state_label / card_url ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("state", "label"),
    [(1, "queued"), (2, "in progress"), (3, "done"), (None, ""), (99, "99")],
)
def test_state_label(state: int | None, label: str) -> None:
    assert state_label(state) == label


@pytest.mark.parametrize("base", ["https://btlz.kaiten.ru", "https://btlz.kaiten.ru/"])
def test_card_url_strips_trailing_slash(base: str) -> None:
    assert card_url(base, 123) == "https://btlz.kaiten.ru/123"


# ── parse_card ─────────────────────────────────────────────────────────────────


def test_parse_card_full() -> None:
    raw = {
        "id": 42,
        "title": "Fix loader",
        "state": 2,
        "condition": 1,
        "due_date": "2026-06-30T23:59:59Z",
        "updated": "2026-06-04T10:00:00.000Z",
        "board_id": 7,
        "column_id": 100,
    }
    card = parse_card(raw, "https://btlz.kaiten.ru")
    assert card.id == 42
    assert card.title == "Fix loader"
    assert card.state == 2
    assert card.condition == 1
    assert card.due_date == "2026-06-30T23:59:59Z"
    assert card.updated == "2026-06-04T10:00:00.000Z"
    assert card.board_id == 7
    assert card.column_id == 100
    assert card.url == "https://btlz.kaiten.ru/42"


def test_parse_card_missing_optional_fields() -> None:
    card = parse_card({"id": 1}, "https://btlz.kaiten.ru")
    assert card.id == 1
    assert card.title == ""
    assert card.state is None
    assert card.condition is None
    assert card.due_date is None
    assert card.updated is None
    assert card.board_id is None
    assert card.column_id is None


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


# ── coalesce ───────────────────────────────────────────────────────────────────


def test_coalesce_first_non_none() -> None:
    assert coalesce(None, None, 3) == 3
    assert coalesce(1, 2) == 1
    assert coalesce(None, None) is None


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


# ── parse_card_ref: селектор (id / короткий URL / глубокий URL) → id ────────────


@pytest.mark.parametrize(
    "ref",
    [
        "65634936",
        "  65634936  ",
        "https://btlz.kaiten.ru/65634936",
        "https://btlz.kaiten.ru/space/286794/boards/card/65634936?filter=eyJrZXk",
    ],
)
def test_parse_card_ref_valid(ref: str) -> None:
    # глубокий URL: берём ПОСЛЕДНИЙ числовой сегмент (карточку, не space 286794).
    assert parse_card_ref(ref) == 65634936


@pytest.mark.parametrize("ref", ["", "not-a-card", "https://btlz.kaiten.ru/spaces"])
def test_parse_card_ref_invalid(ref: str) -> None:
    with pytest.raises(ValueError, match="не удалось извлечь id"):
        parse_card_ref(ref)


# ── parse_card_detail / parse_member / parse_file / parse_comment / property ─────


def test_parse_card_detail_full() -> None:
    raw = {
        "id": 100,
        "key": "ABC-1",
        "title": "T",
        "state": 2,
        "condition": 1,
        "due_date": "2026-06-30T00:00:00Z",
        "board_id": 7,
        "board": {"id": 7, "title": "Board7"},
        "column_id": 9,
        "column": {"id": 9, "title": "Col9"},
        "lane": {"title": "Lane"},
        "type": {"title": "Bug"},
        "size_text": "M",
        "created": "2026-01-01",
        "updated": "2026-02-02",
        "description": "desc",
        "tags": [{"name": "OZON"}, {"name": "WB"}],
        "owner": {"id": 1, "full_name": "Owner", "email": "o@x", "username": "own"},
        "members": [{"id": 2, "full_name": "Mem", "email": "m@x", "username": "mem"}],
        "files": [{"id": 5, "url": "https://files/x.png", "name": "x.png", "comment_id": None}],
        "properties": {"id_1": "val", "id_2": "https://link", "id_3": None},
    }
    d = parse_card_detail(raw, "https://btlz.kaiten.ru")
    assert (d.id, d.key, d.title, d.state) == (100, "ABC-1", "T", 2)
    assert (d.board_title, d.column_title, d.lane_title) == ("Board7", "Col9", "Lane")
    assert d.type_name == "Bug"
    assert d.tags == ["OZON", "WB"]
    assert d.owner is not None
    assert d.owner.full_name == "Owner"
    assert [m.full_name for m in d.members] == ["Mem"]
    assert d.files[0].url == "https://files/x.png"
    # None-значения свойств отбрасываются; строковые/ссылки сохраняются.
    assert d.properties == {"id_1": "val", "id_2": "https://link"}
    assert d.url == "https://btlz.kaiten.ru/100"


def test_parse_card_detail_minimal() -> None:
    d = parse_card_detail({"id": 1}, "https://btlz.kaiten.ru")
    assert d.id == 1
    assert d.title == ""
    assert d.key is None
    assert d.description is None
    assert d.board_title is None
    assert d.owner is None
    assert d.tags == []
    assert d.members == []
    assert d.files == []
    assert d.properties == {}


def test_parse_member_and_file_and_comment() -> None:
    m = parse_member({"id": 5, "full_name": "A", "email": "a@x", "username": "au"})
    assert (m.id, m.full_name, m.email, m.username) == (5, "A", "a@x", "au")

    f = parse_file({"id": 1, "url": "u", "name": "n", "comment_id": None, "card_cover": True})
    assert f.comment_id is None
    assert f.card_cover is True
    assert f.mime_type is None  # часто отсутствует в API

    c = parse_comment(
        {"id": 9, "text": "hi", "author": {"full_name": "Bob"}, "created": "2026-06-03T06:39:25Z"}
    )
    assert (c.id, c.text, c.author_name, c.created) == (9, "hi", "Bob", "2026-06-03T06:39:25Z")


def test_parse_custom_property() -> None:
    p = parse_custom_property({"id": 542506, "name": "Описание", "type": "string"})
    assert (p.id, p.name, p.type) == (542506, "Описание", "string")


# ── _card_to_markdown: таблицы/ссылки дословно, имена свойств зарезолвлены ───────


def test_card_to_markdown_preserves_tables_links_and_resolves_props() -> None:
    detail = KaitenCardDetail(
        id=1,
        key=None,
        title="Title",
        state=2,
        condition=1,
        due_date=None,
        board_id=7,
        board_title="B",
        column_id=9,
        column_title="C",
        lane_title=None,
        size_text=None,
        created=None,
        updated=None,
        type_name=None,
        description="| A | B |\n|---|---|\n| 1 | 2 |",
        owner=None,
        url="https://btlz.kaiten.ru/1",
        tags=[],
        members=[],
        files=[
            KaitenFile(
                id=5,
                url="https://files/x.png",
                name="x.png",
                mime_type=None,
                comment_id=None,
                card_cover=False,
            )
        ],
        properties={"id_398965": "https://gitlab/mr/1"},
    )
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    md = _card_to_markdown(detail, comments, {398965: "Ссылка на Pull Request"})
    assert "# Title" in md
    assert "| A | B |" in md  # таблица из описания — дословно
    assert "|---|---|" in md
    assert "- [x.png](https://files/x.png)" in md  # файл как markdown-ссылка
    assert "- Ссылка на Pull Request: https://gitlab/mr/1" in md  # имя свойства зарезолвлено
    assert "### Bob · 2026-06-03 06:39" in md  # шапка комментария
    assert "hello" in md


# ── resolve_comment_text: тело из ровно одного источника (-m / -F / stdin) ───────


def _no_stdin() -> str:
    raise AssertionError("stdin не должен читаться без `-F -`")


def test_resolve_comment_text_message() -> None:
    assert resolve_comment_text("привет", None, stdin_read=_no_stdin) == "привет"


def test_resolve_comment_text_file(tmp_path: Path) -> None:
    body_file = tmp_path / "body.md"
    body_file.write_text("**из файла**", encoding="utf-8")
    assert resolve_comment_text(None, str(body_file), stdin_read=_no_stdin) == "**из файла**"


def test_resolve_comment_text_stdin() -> None:
    assert resolve_comment_text(None, "-", stdin_read=lambda: "из stdin") == "из stdin"


def test_resolve_comment_text_exactly_one_source() -> None:
    # ни одного источника...
    with pytest.raises(typer.BadParameter):
        resolve_comment_text(None, None, stdin_read=_no_stdin)
    # ...и оба сразу — оба запрещены.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("a", "-", stdin_read=_no_stdin)


def test_resolve_comment_text_empty_and_missing_file(tmp_path: Path) -> None:
    # пустое тело (только пробелы) → ошибка.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("   \n", None, stdin_read=_no_stdin)
    # несуществующий файл → BadParameter, не OSError наружу.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text(None, str(tmp_path / "nope.md"), stdin_read=_no_stdin)


def test_resolve_comment_text_optional_with_attachments() -> None:
    # есть вложения (require_text=False): оба источника опущены → пустой текст, не ошибка.
    assert resolve_comment_text(None, None, stdin_read=_no_stdin, require_text=False) == ""
    # текст при этом всё ещё можно передать.
    assert (
        resolve_comment_text("подпись", None, stdin_read=_no_stdin, require_text=False) == "подпись"
    )
    # оба источника сразу запрещены даже с вложениями.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("a", "-", stdin_read=_no_stdin, require_text=False)


# ── read_attachments: пути → (имя, байты); понятная ошибка на промахе ────────────


def test_read_attachments_reads_in_order(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    a.write_text("# A", encoding="utf-8")
    b = tmp_path / "b.bin"
    b.write_bytes(b"\x00\x01\x02")
    got = read_attachments([str(a), str(b)])
    assert got == [("a.md", b"# A"), ("b.bin", b"\x00\x01\x02")]


def test_read_attachments_missing_file(tmp_path: Path) -> None:
    with pytest.raises(typer.BadParameter):
        read_attachments([str(tmp_path / "nope.png")])


def test_read_attachments_directory_is_not_a_file(tmp_path: Path) -> None:
    with pytest.raises(typer.BadParameter):
        read_attachments([str(tmp_path)])


# ── build_multipart: текст + файлы под именем files[] ───────────────────────────


def test_build_multipart_text_and_files() -> None:
    body, content_type = build_multipart(
        {"text": "привет"}, [("one.txt", b"ONE"), ("two.md", b"# TWO")]
    )
    assert content_type.startswith("multipart/form-data; boundary=")
    boundary = content_type.split("boundary=", 1)[1]
    assert boundary.encode() in body
    # текстовое поле и оба файла под одним именем files[].
    assert b'name="text"' in body
    assert b"\r\n\r\n\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82\r\n" in body  # utf-8 «привет»
    assert body.count(b'name="files[]"') == 2
    assert b'filename="one.txt"' in body
    assert b'filename="two.md"' in body
    assert b"ONE" in body
    assert b"# TWO" in body
    # корректный завершающий разделитель.
    assert body.rstrip(b"\r\n").endswith(f"--{boundary}--".encode())


def test_build_multipart_sanitizes_filename() -> None:
    body, _ = build_multipart({}, [('a"b\n.txt', b"x")])
    assert b'filename="a%22b .txt"' in body


# ── --to адресаты: разбор, раскрытие @all, постановка строкой в начало ───────────


def test_parse_recipients_flatten_normalize_dedup() -> None:
    # повторяемый + значения через пробел; ведущая @ добавляется; дубли (регистр) убираются.
    assert parse_recipients(["@all @ivan", "petr", "@IVAN"]) == ["@all", "@ivan", "@petr"]
    assert parse_recipients([]) == []


def test_expand_recipients_all_to_owner() -> None:
    line, mentioned = expand_recipients(["@all", "@ivan"], "ownerlogin")
    assert line == "@ownerlogin @ivan"
    assert mentioned == ["ownerlogin", "ivan"]


def test_expand_recipients_all_dedup_with_explicit_owner() -> None:
    # @all → owner, а owner уже указан явно — без дубля.
    line, mentioned = expand_recipients(["@all", "@ownerlogin"], "ownerlogin")
    assert line == "@ownerlogin"
    assert mentioned == ["ownerlogin"]


def test_expand_recipients_no_owner_keeps_all_literal() -> None:
    line, mentioned = expand_recipients(["@all", "@ivan"], None)
    assert line == "@all @ivan"
    # @all не резолвится → в список упомянутых логинов не попадает.
    assert mentioned == ["ivan"]


def test_prepend_recipients_separate_line() -> None:
    assert prepend_recipients("привет", "@ivan") == "@ivan\n\nпривет"
    # пустой текст → только строка адресатов.
    assert prepend_recipients("   ", "@ivan") == "@ivan"
    # нет адресатов → текст без изменений.
    assert prepend_recipients("привет", "") == "привет"


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


# ── _left_neighbor_column: соседняя слева колонка для релог-bump ─────────────────


class _FakeColumnsClient:
    """Мини-клиент, отдаёт фиксированный список колонок (нужен только list_columns)."""

    def __init__(self, columns: list[KaitenColumn]) -> None:
        self._columns = columns

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        _ = board_ids
        return self._columns


def _board_columns() -> list[KaitenColumn]:
    return [
        KaitenColumn(id=10, board_id=1, title="Очередь", sort_order=1.0),
        KaitenColumn(id=20, board_id=1, title="Разработка", sort_order=2.0),
        KaitenColumn(id=30, board_id=1, title="Готово", sort_order=3.0),
    ]


def _fake_client(columns: list[KaitenColumn]) -> KaitenClient:
    # cast: фейк покрывает только list_columns, единственное, что нужно _left_neighbor_column.
    return cast("KaitenClient", _FakeColumnsClient(columns))


def test_left_neighbor_picks_left() -> None:
    assert _left_neighbor_column(_fake_client(_board_columns()), 1, 30) == 20


def test_left_neighbor_leftmost_uses_right() -> None:
    # крайняя левая колонка → берём правую соседку.
    assert _left_neighbor_column(_fake_client(_board_columns()), 1, 10) == 20


def test_left_neighbor_single_column_errors() -> None:
    one = [KaitenColumn(id=10, board_id=1, title="Одна", sort_order=1.0)]
    with pytest.raises(typer.BadParameter):
        _left_neighbor_column(_fake_client(one), 1, 10)


def test_expand_all_mention_basic() -> None:
    # `@all` в начале строки → перечисление логинов участников.
    assert expand_all_mention("@all\n\nтекст", ["ivan", "petr"]) == "@ivan @petr\n\nтекст"


def test_expand_all_mention_no_token_unchanged() -> None:
    assert expand_all_mention("привет команда", ["ivan"]) == "привет команда"


def test_expand_all_mention_empty_handles_left_as_is() -> None:
    # нечего разворачивать → литеральный `@all` остаётся (безвреден).
    assert expand_all_mention("@all привет", []) == "@all привет"


def test_expand_all_mention_word_boundary_skips_emails_and_words() -> None:
    # не часть e-mail/слова — не трогаем.
    assert expand_all_mention("see karkhaninas@all.com", ["ivan"]) == "see karkhaninas@all.com"
    assert expand_all_mention("@allies сегодня", ["ivan"]) == "@allies сегодня"


def test_expand_all_mention_case_insensitive_and_multiple() -> None:
    assert expand_all_mention("@all и ещё @ALL", ["a", "b"]) == "@a @b и ещё @a @b"


def _card_with_owner(username: str | None) -> KaitenCardDetail:
    raw: dict[str, object] = {"id": 1}
    if username is not None:
        raw["owner"] = {"id": 9, "full_name": "Василий", "email": "e@x", "username": username}
    return parse_card_detail(raw, "https://btlz.kaiten.ru")


def test_expand_all_to_owner_uses_owner_username() -> None:
    card = _card_with_owner("10XSystPod1")
    text, mentioned = _expand_all_to_owner("@all\n\nответ", card)
    assert text == "@10XSystPod1\n\nответ"
    assert mentioned == ["10XSystPod1"]


def test_expand_all_to_owner_no_owner_left_as_is() -> None:
    text, mentioned = _expand_all_to_owner("@all привет", _card_with_owner(None))
    assert text == "@all привет"
    assert mentioned == []


def test_expand_all_to_owner_no_token_unchanged() -> None:
    text, mentioned = _expand_all_to_owner("просто текст", _card_with_owner("10XSystPod1"))
    assert text == "просто текст"
    assert mentioned == []


def test_plan_field_actions_sets_only_empty() -> None:
    current = {"hypothesis": "уже есть", "done": None, "result": "  "}
    provided = {"hypothesis": "h", "done": "d", "result": "r", "mr": None}
    to_set, skipped = plan_field_actions(current, provided, force=False)
    assert to_set == [("done", "d"), ("result", "r")]  # done=None и result=пробелы → пишем
    assert skipped == ["hypothesis"]  # непустое → пропуск


def test_plan_field_actions_force_overwrites() -> None:
    current: dict[str, str | None] = {"hypothesis": "уже есть"}
    to_set, skipped = plan_field_actions(current, {"hypothesis": "h"}, force=True)
    assert to_set == [("hypothesis", "h")]
    assert skipped == []


def test_plan_field_actions_skips_not_provided() -> None:
    to_set, skipped = plan_field_actions({}, {"hypothesis": None, "done": None}, force=False)
    assert to_set == []
    assert skipped == []


# ════════════════════════════════════════════════════════════════════════════════
# CLI-уровень: драйв `app` через CliRunner. Весь I/O-клиент (`KaitenClient.from_env`),
# кэш (`kaiten_cache.*`), журнал (`store`/`kaiten_links`) и env замоканы на именованных
# швах — сети/PG/ssh нет. Зеркало паттерна test_kaiten_cache.py (_FakeKaitenClient + _Stub).
# ════════════════════════════════════════════════════════════════════════════════

runner = CliRunner()


class FakeKaitenClient:
    """Фейк `KaitenClient` для CLI-команд: фиксированные фикстуры + журнал вызовов.

    `get_card` отдаёт элементы `details` по очереди (последний остаётся «залипшим»),
    что позволяет различать before/after одного card_id. Метод из `fail` бросает
    `KaitenAPIError` — для error-веток команд.
    """

    def __init__(
        self,
        *,
        base_url: str = "https://btlz.kaiten.ru",
        user: KaitenUser | None = None,
        cards: list[KaitenCard] | None = None,
        details: list[KaitenCardDetail] | None = None,
        comments: list[KaitenComment] | None = None,
        columns: list[KaitenColumn] | None = None,
        new_comment_id: int = 777,
        fail: set[str] | None = None,
    ) -> None:
        self.base_url = base_url
        self._user = user
        self._cards = cards if cards is not None else []
        self._details = details if details is not None else [_detail()]
        self._comments = comments if comments is not None else []
        self._columns = columns if columns is not None else []
        self._new_comment_id = new_comment_id
        self._fail: set[str] = fail if fail is not None else set()
        self.get_card_ids: list[int] = []
        self.list_cards_kwargs: dict[str, object] = {}
        self.move_calls: list[dict[str, int | None]] = []
        self.added_comments: list[dict[str, object]] = []
        self.props_set: list[tuple[int, str, str | None]] = []

    def _maybe_fail(self, name: str) -> None:
        if name in self._fail:
            raise KaitenAPIError("GET", f"/{name}", 500, "boom")

    def current_user(self) -> KaitenUser:
        self._maybe_fail("current_user")
        assert self._user is not None
        return self._user

    def list_cards(self, **kwargs: object) -> list[KaitenCard]:
        self._maybe_fail("list_cards")
        self.list_cards_kwargs = dict(kwargs)
        return self._cards

    def get_card(self, card_id: int) -> KaitenCardDetail:
        self._maybe_fail("get_card")
        self.get_card_ids.append(card_id)
        if len(self._details) > 1:
            return self._details.pop(0)
        return self._details[0]

    def get_comments(self, card_id: int) -> list[KaitenComment]:
        self._maybe_fail("get_comments")
        _ = card_id
        return self._comments

    def add_comment(
        self, card_id: int, text: str, files: list[tuple[str, bytes]] | None = None
    ) -> KaitenComment:
        self._maybe_fail("add_comment")
        self.added_comments.append({"card_id": card_id, "text": text, "files": files})
        return KaitenComment(id=self._new_comment_id, text=text, author_name="me", created=None)

    def move_card(
        self,
        card_id: int,
        *,
        lane_id: int | None = None,
        column_id: int | None = None,
        board_id: int | None = None,
    ) -> KaitenCardDetail:
        self._maybe_fail("move_card")
        self.move_calls.append(
            {"card_id": card_id, "lane_id": lane_id, "column_id": column_id, "board_id": board_id}
        )
        return self._details[-1]

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        self._maybe_fail("list_columns")
        _ = board_ids
        return self._columns

    def set_card_property(self, card_id: int, property_key: str, value: str | None) -> None:
        self._maybe_fail("set_card_property")
        self.props_set.append((card_id, property_key, value))


def _detail(
    *,
    card_id: int = 100,
    title: str = "Card",
    board_id: int | None = 1,
    board_title: str | None = "Board",
    column_id: int | None = 10,
    column_title: str | None = "Очередь",
    lane_title: str | None = "Lane",
    owner_username: str | None = None,
    properties: dict[str, str] | None = None,
) -> KaitenCardDetail:
    """Собрать `KaitenCardDetail` напрямую (без сети) с управляемым положением/владельцем."""
    owner = (
        KaitenMember(id=9, full_name="Owner", email="o@x", username=owner_username)
        if owner_username is not None
        else None
    )
    return KaitenCardDetail(
        id=card_id,
        key=None,
        title=title,
        state=2,
        condition=1,
        due_date=None,
        board_id=board_id,
        board_title=board_title,
        column_id=column_id,
        column_title=column_title,
        lane_title=lane_title,
        size_text=None,
        created=None,
        updated=None,
        type_name=None,
        description=None,
        owner=owner,
        url=f"https://btlz.kaiten.ru/{card_id}",
        tags=[],
        members=[],
        files=[],
        properties=properties or {},
    )


def _install_client(monkeypatch: pytest.MonkeyPatch, fake: FakeKaitenClient) -> None:
    """Подменить `KaitenClient.from_env()` в модуле команды — возвращает фейк."""

    class _Stub:
        @staticmethod
        def from_env() -> FakeKaitenClient:
            return fake

    monkeypatch.setattr(kiten_mod, "KaitenClient", _Stub)


def _install_env(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    """Подменить `env.get` словарём (изоляция от реального ~/.config/mpu/.env)."""

    def _get(name: str, default: str | None = None) -> str | None:
        return values.get(name, default)

    monkeypatch.setattr(env, "get", _get)


def _patch_columns_cache(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[int, str]]) -> None:
    def _cached(board_id: int | None = None) -> list[tuple[int, str]]:
        _ = board_id
        return rows

    monkeypatch.setattr(kaiten_cache, "cached_columns", _cached)


def _patch_spaces_cache(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[int, str]]) -> None:
    def _cached() -> list[tuple[int, str]]:
        return rows

    monkeypatch.setattr(kaiten_cache, "cached_spaces", _cached)


def _patch_prop_names(monkeypatch: pytest.MonkeyPatch, names: dict[int, str]) -> None:
    def _names() -> dict[int, str]:
        return names

    monkeypatch.setattr(kaiten_cache, "property_names", _names)


def _patch_discover(
    monkeypatch: pytest.MonkeyPatch,
    *,
    spaces: list[KaitenSpace] | None = None,
    boards: list[KaitenBoard] | None = None,
    error: str | None = None,
) -> None:
    result = KaitenDiscoveryResult(spaces=spaces or [], boards=boards or [], error=error)

    def _disc() -> KaitenDiscoveryResult:
        return result

    monkeypatch.setattr(kaiten_cache, "discover_and_store", _disc)


def _patch_lanes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    lanes: list[KaitenLane] | None = None,
    error: str | None = None,
) -> None:
    result = KaitenLanesResult(lanes=lanes or [], error=error)

    def _disc(board_ids: list[int]) -> KaitenLanesResult:
        _ = board_ids
        return result

    monkeypatch.setattr(kaiten_cache, "discover_lanes_and_store", _disc)


def _patch_columns_disc(
    monkeypatch: pytest.MonkeyPatch,
    *,
    columns: list[KaitenColumn] | None = None,
    error: str | None = None,
) -> None:
    result = KaitenColumnsResult(columns=columns or [], error=error)

    def _disc(board_ids: list[int]) -> KaitenColumnsResult:
        _ = board_ids
        return result

    monkeypatch.setattr(kaiten_cache, "discover_columns_and_store", _disc)


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Временный путь `mpu.db` + redirect `store.DB_PATH` (журнал перемещений/привязок)."""
    path = tmp_path / "kiten.db"
    monkeypatch.setattr(store, "DB_PATH", path)
    return path


def _moves() -> list[kaiten_links.CardMove]:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.list_moves(conn)


def _links() -> list[kaiten_links.CardLink]:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.list_links(conn)


def _seed_link(card_id: int, field: str, value: str) -> kaiten_links.CardLink:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.record_link(conn, card_id, field, value)


def _user() -> KaitenUser:
    return KaitenUser(id=42, full_name="Me", username="me", email="me@x")


_BOARD_COLS: list[tuple[int, str]] = [(10, "Очередь"), (20, "Разработка"), (30, "Готово")]


def _ordered_columns() -> list[KaitenColumn]:
    return [
        KaitenColumn(id=10, board_id=1, title="Очередь", sort_order=1.0),
        KaitenColumn(id=20, board_id=1, title="Разработка", sort_order=2.0),
        KaitenColumn(id=30, board_id=1, title="Готово", sort_order=3.0),
    ]


# ── whoami ──────────────────────────────────────────────────────────────────────


def test_whoami_text(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient(user=_user()))
    res = runner.invoke(app, ["whoami"])
    assert res.exit_code == 0, res.stderr
    assert "id:    42" in res.output
    assert "login: me" in res.output
    assert "email: me@x" in res.output


def test_whoami_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient(user=_user()))
    res = runner.invoke(app, ["whoami", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: dict[str, Any] = json.loads(res.output)
    assert payload == {"id": 42, "full_name": "Me", "username": "me", "email": "me@x"}


def test_whoami_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), fail={"current_user"}))
    res = runner.invoke(app, ["whoami"])
    assert res.exit_code == 1
    assert "kaiten error" in res.stderr


# ── ls ──────────────────────────────────────────────────────────────────────────


def _card(card_id: int = 42, *, state: int | None = 2, column_id: int | None = 10) -> KaitenCard:
    return KaitenCard(
        id=card_id,
        title=f"Card {card_id}",
        state=state,
        condition=1,
        due_date="2026-06-30T23:59:59Z",
        updated="2026-06-04T10:00:00Z",
        board_id=7,
        column_id=column_id,
        url=f"https://btlz.kaiten.ru/{card_id}",
    )


def test_ls_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42)]))
    res = runner.invoke(app, ["ls", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload[0]["id"] == 42
    assert payload[0]["state"] == "in progress"
    assert payload[0]["url"] == "https://btlz.kaiten.ru/42"


def test_ls_empty_table(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[]))
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 0, res.stderr
    assert "(нет карточек)" in res.output


def test_ls_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42), _card(43)]))
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 0, res.stderr
    assert "(2 cards)" in res.output


def test_ls_only_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42)]))
    res = runner.invoke(app, ["ls", "--only-url"])
    assert res.exit_code == 0, res.stderr
    assert "[Card 42](https://btlz.kaiten.ru/42)" in res.output


def test_ls_md_table(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42)]))
    res = runner.invoke(app, ["ls", "--md"])
    assert res.exit_code == 0, res.stderr
    assert "| ID | STATE | COLUMN | DUE | TITLE | URL |" in res.output
    assert "https://btlz.kaiten.ru/42" in res.output


def test_ls_format_template(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, [(10, "Очередь")])
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42)]))
    res = runner.invoke(app, ["ls", "--format", "{id}|{state}|{column}|{due}"])
    assert res.exit_code == 0, res.stderr
    assert "42|in progress|Очередь|2026-06-30" in res.output


def test_ls_filters_passed_to_list_cards(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=_user(), cards=[])
    _install_client(monkeypatch, fake)
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
    _install_env(monkeypatch, {"KITEN_LS_BOARD_ID": "7"})
    fake = FakeKaitenClient(user=_user(), cards=[])
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        app, ["ls", "--json", "--date-from", "2026-05-01", "--date-to", "2026-06-04"]
    )
    assert res.exit_code == 0, res.stderr
    assert fake.list_cards_kwargs["condition"] is None
    assert fake.list_cards_kwargs["board_id"] is None
    assert fake.list_cards_kwargs["updated_after"] == "2026-05-01T00:00:00Z"
    assert fake.list_cards_kwargs["updated_before"] == "2026-06-04T23:59:59Z"


def test_ls_space_substring_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _patch_spaces_cache(monkeypatch, [(5, "10X Support")])
    fake = FakeKaitenClient(user=_user(), cards=[])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ls", "--json", "--space", "Support"])
    assert res.exit_code == 0, res.stderr
    assert fake.list_cards_kwargs["space_id"] == 5


def test_ls_bad_space_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _patch_spaces_cache(monkeypatch, [])
    _install_client(monkeypatch, FakeKaitenClient(user=_user()))
    res = runner.invoke(app, ["ls", "--space", "Nope"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr


def test_ls_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), fail={"list_cards"}))
    res = runner.invoke(app, ["ls"])
    assert res.exit_code == 1
    assert "ls: kaiten error" in res.stderr


# ── card ────────────────────────────────────────────────────────────────────────


def _rich_detail() -> KaitenCardDetail:
    return KaitenCardDetail(
        id=100,
        key="ABC-1",
        title="Title",
        state=2,
        condition=1,
        due_date="2026-06-30T00:00:00Z",
        board_id=7,
        board_title="Board7",
        column_id=9,
        column_title="Col9",
        lane_title="Lane",
        size_text="M",
        created="2026-01-01",
        updated="2026-02-02",
        type_name="Bug",
        description="| A | B |\n|---|---|\n| 1 | 2 |",
        owner=KaitenMember(id=1, full_name="Owner", email="o@x", username="own"),
        url="https://btlz.kaiten.ru/100",
        tags=["OZON"],
        members=[KaitenMember(id=2, full_name="Mem", email="m@x", username="mem")],
        files=[],
        properties={"id_398965": "https://gitlab/mr/1"},
    )


def test_card_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_prop_names(monkeypatch, {})
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    _install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], comments=comments))
    res = runner.invoke(app, ["card", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: dict[str, Any] = json.loads(res.output)
    assert payload["id"] == 100
    assert payload["title"] == "Title"
    assert payload["comments"][0]["text"] == "hello"


def test_card_markdown_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # Под CliRunner stdout не tty → дефолт даёт markdown (без rich/term-image).
    _patch_prop_names(monkeypatch, {398965: "Ссылка на Pull Request"})
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    _install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], comments=comments))
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 0, res.stderr
    assert "# Title" in res.output
    assert "Ссылка на Pull Request: https://gitlab/mr/1" in res.output
    assert "### Bob · 2026-06-03 06:39" in res.output


def test_card_no_comments(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_prop_names(monkeypatch, {})
    fake = FakeKaitenClient(details=[_rich_detail()], comments=[])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["card", "100", "--md", "--no-comments"])
    assert res.exit_code == 0, res.stderr
    assert "## Комментарии" not in res.output


def test_card_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_prop_names(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], fail={"get_card"}))
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 1
    assert "card: kaiten error" in res.stderr


def test_card_bad_selector_exits_2() -> None:
    res = runner.invoke(app, ["card", "not-a-card"])
    assert res.exit_code == 2
    assert "не удалось извлечь id" in res.stderr


# ── comment ─────────────────────────────────────────────────────────────────────


def test_comment_message(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "привет"])
    assert res.exit_code == 0, res.stderr
    assert "ok: комментарий 777 → https://btlz.kaiten.ru/100" in res.output
    assert fake.added_comments == [{"card_id": 100, "text": "привет", "files": None}]
    assert fake.get_card_ids == []  # владелец не нужен → get_card не звался


def test_comment_body_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    body = tmp_path / "body.md"
    body.write_text("**из файла**", encoding="utf-8")
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-F", str(body)])
    assert res.exit_code == 0, res.stderr
    assert fake.added_comments[0]["text"] == "**из файла**"


def test_comment_with_attachments(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    att = tmp_path / "a.png"
    att.write_bytes(b"\x89PNG")
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-f", str(att)])
    assert res.exit_code == 0, res.stderr
    assert "вложения: a.png" in res.output
    files = fake.added_comments[0]["files"]
    assert files == [("a.png", b"\x89PNG")]


def test_comment_to_all_expands_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[_detail(owner_username="ownerlogin")])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "ответ", "--to", "@all"])
    assert res.exit_code == 0, res.stderr
    assert "адресаты: @ownerlogin" in res.output
    text = fake.added_comments[0]["text"]
    assert isinstance(text, str)
    assert text.startswith("@ownerlogin")


def test_comment_to_all_no_owner_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[_detail(owner_username=None)])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "ответ", "--to", "@all"])
    assert res.exit_code == 0, res.stderr
    assert "нет владельца" in res.stderr


def test_comment_all_mention_in_text(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[_detail(owner_username="ownerlogin")])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "@all внимание"])
    assert res.exit_code == 0, res.stderr
    text = fake.added_comments[0]["text"]
    assert text == "@ownerlogin внимание"


def test_comment_no_text_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["comment", "100"])
    assert res.exit_code == 2
    assert "ровно одно" in res.stderr


def test_comment_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient(fail={"add_comment"}))
    res = runner.invoke(app, ["comment", "100", "-m", "x"])
    assert res.exit_code == 1
    assert "comment: kaiten error" in res.stderr


# ── move ────────────────────────────────────────────────────────────────────────


def test_move_no_axis_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["move", "100"])
    assert res.exit_code == 2
    assert "хотя бы одно" in res.stderr


def test_move_column_numeric(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 0, res.stderr
    assert "→ Board · Готово · Lane" in res.output
    assert fake.move_calls == [{"card_id": 100, "lane_id": None, "column_id": 30, "board_id": None}]
    moves = _moves()
    assert len(moves) == 1
    assert moves[0].to_column == "Готово"
    assert moves[0].from_column == "Очередь"


def test_move_column_name_resolved(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "Готово"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 30


def test_move_relog_when_already_in_column(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = _detail(column_id=30, column_title="Готово")
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after], columns=_ordered_columns())
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 0, res.stderr
    assert "(релог)" in res.output
    assert [c["column_id"] for c in fake.move_calls] == [20, 30]  # сосед слева → обратно


def test_move_to_board(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=10, column_title="Очередь", board_title="Other")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--board", "2"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["board_id"] == 2


def test_move_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(details=[_detail()], fail={"get_card"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 1
    assert "move: kaiten error" in res.stderr
    assert _moves() == []


# ── ready / review (через _move_to_target_column) ───────────────────────────────


def test_ready_default_target(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 30
    moves = _moves()
    assert moves[0].to_column == "Готово"


def test_ready_env_column_override(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {"KITEN_READY_COLUMN": "Разработка"})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=20, column_title="Разработка")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 20


def test_ready_column_flag_numeric(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=20, column_title="Разработка")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100", "--column", "20"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 20


def test_ready_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    fake = FakeKaitenClient(details=[_detail(column_id=10, column_title="Очередь")])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert "dry-run:" in res.output
    assert "PATCH не отправлен" in res.output
    assert fake.move_calls == []
    assert _moves() == []


def test_ready_relog(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=30, column_title="Готово")
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after], columns=_ordered_columns())
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert "(релог)" in res.output
    assert [c["column_id"] for c in fake.move_calls] == [20, 30]


def test_ready_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail()], fail={"get_card"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 1
    assert "kaiten error" in res.stderr


def test_review_default_target(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, [(10, "Очередь"), (40, "Код-ревью")])
    before = _detail(column_id=10, column_title="Очередь")
    after = _detail(column_id=40, column_title="Код-ревью")
    fake = FakeKaitenClient(details=[before, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["review", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 40
    assert _moves()[0].to_column == "Код-ревью"


# ── close ───────────────────────────────────────────────────────────────────────


def test_close_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(owner_username="ownerlogin", properties={})
    fake = FakeKaitenClient(details=[before, before])
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        app,
        ["close", "100", "--hypothesis", "h", "--done", "d", "--reply", "@all привет", "--dry-run"],
    )
    assert res.exit_code == 0, res.stderr
    assert "dry-run close" in res.output
    assert "поля: записать [hypothesis, done]" in res.output
    assert "ответ: запостить (@all → @ownerlogin)" in res.output
    assert fake.props_set == []
    assert fake.added_comments == []
    assert _moves() == []


def test_close_dry_run_no_move(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail(properties={})])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert "перенос: пропущен (--no-move)" in res.output


def test_close_fills_fields_reply_and_moves(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=10, column_title="Очередь", properties={})
    before2 = _detail(column_id=10, column_title="Очередь", properties={})
    after = _detail(column_id=30, column_title="Готово", properties={})
    fake = FakeKaitenClient(details=[before, before2, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        app,
        ["close", "100", "--hypothesis", "h", "--done", "d", "--result", "r", "--reply", "Спасибо"],
    )
    assert res.exit_code == 0, res.stderr
    assert "ok close: поля [hypothesis, done, result]" in res.output
    assert "ответ: комментарий 777" in res.output
    assert fake.props_set == [
        (100, "id_291984", "h"),
        (100, "id_291985", "d"),
        (100, "id_291990", "r"),
    ]
    assert fake.added_comments[0]["text"] == "Спасибо"
    assert _moves()[0].to_column == "Готово"
    # три записи лога полей.
    assert {link.field for link in _links()} == {"hypothesis", "done", "result"}


def test_close_skips_filled_field(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _patch_columns_cache(monkeypatch, _BOARD_COLS)
    before = _detail(column_id=10, properties={"id_291984": "уже есть"})
    before2 = _detail(column_id=10, properties={"id_291984": "уже есть"})
    after = _detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, before2, after])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "new"])
    assert res.exit_code == 0, res.stderr
    assert "пропущены (заполнены) [hypothesis]" in res.output
    assert fake.props_set == []  # ничего не записали (поле уже заполнено)


def test_close_no_move(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail(properties={})])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert fake.props_set == [(100, "id_291984", "h")]
    assert _moves() == []  # перенос пропущен


def test_close_reply_file(monkeypatch: pytest.MonkeyPatch, db_path: Path, tmp_path: Path) -> None:
    _install_env(monkeypatch, {})
    reply = tmp_path / "reply.md"
    reply.write_text("ответ из файла", encoding="utf-8")
    fake = FakeKaitenClient(details=[_detail(properties={})])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply-file", str(reply), "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert fake.added_comments[0]["text"] == "ответ из файла"


def test_close_reply_and_reply_file_exclusive(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(details=[_detail()]))
    res = runner.invoke(app, ["close", "100", "--reply", "a", "--reply-file", "-"])
    assert res.exit_code == 2
    assert "взаимоисключающи" in res.stderr


def test_close_empty_reply_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(details=[_detail()]))
    res = runner.invoke(app, ["close", "100", "--reply", "   "])
    assert res.exit_code == 2
    assert "пустой текст ответа" in res.stderr


def test_close_reply_all_no_owner_warns(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail(owner_username=None, properties={})])
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply", "@all привет", "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert "нет владельца" in res.stderr


def test_close_error_before_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail()], fail={"get_card"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h"])
    assert res.exit_code == 1
    assert "close: kaiten error" in res.stderr


def test_close_error_in_fields_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail(properties={})], fail={"set_card_property"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move"])
    assert res.exit_code == 1
    assert "kaiten error (поля)" in res.stderr


def test_close_error_in_reply_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[_detail(properties={})], fail={"add_comment"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply", "текст", "--no-move"])
    assert res.exit_code == 1
    assert "kaiten error (ответ)" in res.stderr


# ── spaces / boards / lanes / columns ───────────────────────────────────────────


def test_spaces_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, spaces=[KaitenSpace(id=5, title="Support", archived=False)])
    res = runner.invoke(app, ["spaces", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 5, "title": "Support", "archived": False}]


def test_spaces_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, spaces=[KaitenSpace(id=5, title="Support", archived=False)])
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 0, res.stderr
    assert "(1 spaces)" in res.output


def test_spaces_hides_archived_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(
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
    _patch_discover(monkeypatch, spaces=[])
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 0, res.stderr
    assert "(нет пространств)" in res.output


def test_spaces_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, error="kaiten: boom")
    res = runner.invoke(app, ["spaces"])
    assert res.exit_code == 1
    assert "spaces: kaiten error: kaiten: boom" in res.stderr


def test_boards_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 7, "space_id": 5, "title": "B"}]


def test_boards_space_filter_numeric(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(
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
    _patch_spaces_cache(monkeypatch, [(5, "Support")])
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards", "--json", "--space", "Supp"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [b["id"] for b in payload] == [7]


def test_boards_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[])
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 0, res.stderr
    assert "(нет досок)" in res.output


def test_boards_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, error="kaiten: down")
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 1
    assert "boards: kaiten error" in res.stderr


def test_lanes_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="Support")])
    res = runner.invoke(app, ["lanes", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 9, "board_id": 7, "title": "Support"}]


def test_lanes_board_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(
        monkeypatch,
        boards=[
            KaitenBoard(id=7, space_id=5, title="B7"),
            KaitenBoard(id=8, space_id=5, title="B8"),
        ],
    )
    _patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="L")])
    res = runner.invoke(app, ["lanes", "--json", "--board", "7"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 9, "board_id": 7, "title": "L"}]


def test_lanes_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_lanes(monkeypatch, lanes=[])
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 0, res.stderr
    assert "(нет дорожек)" in res.output


def test_lanes_discover_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, error="kaiten: down")
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 1
    assert "lanes: kaiten error" in res.stderr


def test_lanes_lanes_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_lanes(monkeypatch, error="kaiten: lane boom")
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 1
    assert "lanes: kaiten error: kaiten: lane boom" in res.stderr


def test_columns_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_columns_disc(monkeypatch, columns=[KaitenColumn(id=30, board_id=7, title="Готово")])
    res = runner.invoke(app, ["columns", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload == [{"id": 30, "board_id": 7, "title": "Готово"}]


def test_columns_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_columns_disc(monkeypatch, error="kaiten: col boom")
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 1
    assert "columns: kaiten error: kaiten: col boom" in res.stderr


# ── field set / ls / update / rm ────────────────────────────────────────────────


def test_field_set(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "set", "100", "mr", "https://mr/1"])
    assert res.exit_code == 0, res.stderr
    assert "ok: mr → https://mr/1" in res.output
    assert fake.props_set == [(100, "id_398965", "https://mr/1")]
    assert _links()[0].value == "https://mr/1"


def test_field_set_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(fail={"set_card_property"})
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "set", "100", "mr", "https://mr/1"])
    assert res.exit_code == 1
    assert "field set: kaiten error" in res.stderr


def test_field_ls_empty(db_path: Path) -> None:
    res = runner.invoke(app, ["field", "ls"])
    assert res.exit_code == 0, res.stderr
    assert "(пусто)" in res.output


def test_field_ls_json(db_path: Path) -> None:
    _seed_link(100, "mr", "https://mr/1")
    res = runner.invoke(app, ["field", "ls", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload[0]["card_id"] == 100
    assert payload[0]["field"] == "mr"
    assert payload[0]["value"] == "https://mr/1"


def test_field_ls_filter_by_card_and_kind(db_path: Path) -> None:
    _seed_link(100, "mr", "https://mr/1")
    _seed_link(200, "done", "сделано")
    res = runner.invoke(app, ["field", "ls", "--card", "100", "--kind", "mr", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [link["card_id"] for link in payload] == [100]


def test_field_update(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = _seed_link(100, "mr", "https://old")
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "update", str(link.id), "https://new"])
    assert res.exit_code == 0, res.stderr
    assert f"ok: #{link.id} mr → https://new" in res.output
    assert fake.props_set == [(100, "id_398965", "https://new")]


def test_field_update_missing_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["field", "update", "999", "x"])
    assert res.exit_code == 1
    assert "записи #999 нет" in res.stderr


def test_field_rm_resyncs_to_previous(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _seed_link(100, "mr", "https://v1")
    link2 = _seed_link(100, "mr", "https://v2")
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "rm", str(link2.id)])
    assert res.exit_code == 0, res.stderr
    assert "удалена" in res.output
    assert fake.props_set == [(100, "id_398965", "https://v1")]  # откат к предыдущей записи


def test_field_rm_last_clears_field(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = _seed_link(100, "mr", "https://only")
    fake = FakeKaitenClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "rm", str(link.id)])
    assert res.exit_code == 0, res.stderr
    assert "(очищено)" in res.output
    assert fake.props_set == [(100, "id_398965", None)]


def test_field_rm_missing_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["field", "rm", "999"])
    assert res.exit_code == 1
    assert "записи #999 нет" in res.stderr


def test_field_update_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = _seed_link(100, "mr", "https://old")
    _install_client(monkeypatch, FakeKaitenClient(fail={"set_card_property"}))
    res = runner.invoke(app, ["field", "update", str(link.id), "https://new"])
    assert res.exit_code == 1
    assert "field update: kaiten error" in res.stderr


def test_field_rm_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = _seed_link(100, "mr", "https://only")
    _install_client(monkeypatch, FakeKaitenClient(fail={"set_card_property"}))
    res = runner.invoke(app, ["field", "rm", str(link.id)])
    assert res.exit_code == 1
    assert "field rm: kaiten error" in res.stderr


# ── card: наглядный rich-рендер (TTY) ───────────────────────────────────────────


class _FakeStdout:
    @staticmethod
    def isatty() -> bool:
        return True


class _FakeSys:
    """Подмена `kiten.sys` для card: stdout.isatty() == True → ветка rich-рендера."""

    stdout = _FakeStdout()


def _patch_render(monkeypatch: pytest.MonkeyPatch, *, image_ok: bool = True) -> None:
    """No-op заглушки kaiten_render (без term-image/сети): картинки рендерятся «успешно»."""

    def _render_md(console: object, md: str, *, images: bool, max_width: int = 80) -> None:
        _ = (console, md, images, max_width)

    def _inline(md: str) -> list[str]:
        _ = md
        return []

    def _is_image(url_or_name: str) -> bool:
        return url_or_name.endswith(".png")

    def _fetch(url: str, *, timeout: float = 15.0) -> bytes | None:
        _ = (url, timeout)
        return b"PNGDATA"

    def _render_image(data: bytes, *, max_width: int = 80) -> bool:
        _ = (data, max_width)
        return image_ok

    monkeypatch.setattr(kaiten_render, "render_markdown_with_images", _render_md)
    monkeypatch.setattr(kaiten_render, "inline_image_urls", _inline)
    monkeypatch.setattr(kaiten_render, "is_image_url", _is_image)
    monkeypatch.setattr(kaiten_render, "fetch_image_bytes", _fetch)
    monkeypatch.setattr(kaiten_render, "render_image", _render_image)


def _detail_with_image() -> KaitenCardDetail:
    return KaitenCardDetail(
        id=100,
        key="ABC-1",
        title="Title",
        state=2,
        condition=1,
        due_date="2026-06-30T00:00:00Z",
        board_id=7,
        board_title="Board7",
        column_id=9,
        column_title="Col9",
        lane_title="Lane",
        size_text="M",
        created="2026-01-01",
        updated="2026-02-02",
        type_name="Bug",
        description="desc",
        owner=KaitenMember(id=1, full_name="Owner", email="o@x", username="own"),
        url="https://btlz.kaiten.ru/100",
        tags=["OZON"],
        members=[KaitenMember(id=2, full_name="Mem", email="m@x", username="mem")],
        files=[
            KaitenFile(
                id=5,
                url="https://files/pic.png",
                name="pic.png",
                mime_type="image/png",
                comment_id=None,
                card_cover=False,
            )
        ],
        properties={"id_398965": "https://gitlab/mr/1"},
    )


def test_card_rich_render_full(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_mod, "sys", _FakeSys)
    _patch_render(monkeypatch, image_ok=True)
    _patch_prop_names(monkeypatch, {398965: "Ссылка на PR"})
    comments = [KaitenComment(id=2, text="hi", author_name="Bob", created="2026-06-03T06:39:25Z")]
    _install_client(
        monkeypatch, FakeKaitenClient(details=[_detail_with_image()], comments=comments)
    )
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 0, res.stderr
    assert "Title" in res.output  # шапка-панель отрисована


def test_card_rich_render_no_images(monkeypatch: pytest.MonkeyPatch) -> None:
    # --no-images → fetch не зовётся, вложение-картинка показывается ссылкой (ветка fallback).
    monkeypatch.setattr(kiten_mod, "sys", _FakeSys)
    _patch_render(monkeypatch, image_ok=False)
    _patch_prop_names(monkeypatch, {})
    _install_client(monkeypatch, FakeKaitenClient(details=[_detail_with_image()], comments=[]))
    res = runner.invoke(app, ["card", "100", "--no-images"])
    assert res.exit_code == 0, res.stderr
    assert "files/pic.png" in res.output  # ссылка на вложение


def test_card_markdown_nonnumeric_property(monkeypatch: pytest.MonkeyPatch) -> None:
    # Ключ свойства не `id_<число>` → имя поля = сырой ключ (ветка ValueError в _format_property).
    _patch_prop_names(monkeypatch, {})
    detail = _detail(properties={"id_xx": "значение"})
    _install_client(monkeypatch, FakeKaitenClient(details=[detail], comments=[]))
    res = runner.invoke(app, ["card", "100", "--md"])
    assert res.exit_code == 0, res.stderr
    assert "- id_xx: значение" in res.output


# ── ls --format {column_mapped}: KITEN_COLUMN_MAP (валидный / битый / не-объект) ─


def test_ls_format_column_mapped_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {"KITEN_COLUMN_MAP": '{"10": "DONE"}'})
    _patch_columns_cache(monkeypatch, [(10, "Очередь")])
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42, column_id=10)]))
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "DONE" in res.output


def test_ls_format_column_map_bad_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {"KITEN_COLUMN_MAP": "{not json"})
    _patch_columns_cache(monkeypatch, [(10, "Очередь")])
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42, column_id=10)]))
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "некорректный JSON в KITEN_COLUMN_MAP" in res.stderr
    assert "Очередь" in res.output  # фолбэк на сырое имя колонки


def test_ls_format_column_map_not_object(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {"KITEN_COLUMN_MAP": "[]"})
    _patch_columns_cache(monkeypatch, [(10, "Очередь")])
    _install_client(monkeypatch, FakeKaitenClient(user=_user(), cards=[_card(42, column_id=10)]))
    res = runner.invoke(app, ["ls", "--format", "{column_mapped}"])
    assert res.exit_code == 0, res.stderr
    assert "должен быть JSON-объектом" in res.stderr


# ── resolve-ошибки осей перемещения → BadParameter (exit 2) ──────────────────────


def test_move_bad_column_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    _patch_columns_cache(monkeypatch, [])  # пустой кэш → подстрока не резолвится
    _install_client(monkeypatch, FakeKaitenClient(details=[_detail()]))
    res = runner.invoke(app, ["move", "100", "--column", "Неизвестная"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr


def test_move_bad_board_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    def _no_boards(space_id: int | None = None) -> list[tuple[int, str]]:
        _ = space_id
        return []

    monkeypatch.setattr(kaiten_cache, "cached_boards", _no_boards)
    _install_client(monkeypatch, FakeKaitenClient(details=[_detail()]))
    res = runner.invoke(app, ["move", "100", "--board", "Неизвестная"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr


# ── table-smoke (rich-вывод непустых таблиц boards/lanes/columns/field ls) ───────


def test_boards_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    res = runner.invoke(app, ["boards"])
    assert res.exit_code == 0, res.stderr
    assert "(1 boards)" in res.output


def test_lanes_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_lanes(monkeypatch, lanes=[KaitenLane(id=9, board_id=7, title="L")])
    res = runner.invoke(app, ["lanes"])
    assert res.exit_code == 0, res.stderr
    assert "(1 lanes)" in res.output


def test_columns_table_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_columns_disc(monkeypatch, columns=[KaitenColumn(id=30, board_id=7, title="Готово")])
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 0, res.stderr
    assert "(1 columns)" in res.output


def test_columns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_discover(monkeypatch, boards=[KaitenBoard(id=7, space_id=5, title="B")])
    _patch_columns_disc(monkeypatch, columns=[])
    res = runner.invoke(app, ["columns"])
    assert res.exit_code == 0, res.stderr
    assert "(нет колонок)" in res.output


def test_field_ls_table_smoke(db_path: Path) -> None:
    _seed_link(100, "mr", "https://mr/1")
    res = runner.invoke(app, ["field", "ls"])
    assert res.exit_code == 0, res.stderr
    assert "https://mr/1" in res.output


# ── completion-хелперы (best-effort, при ошибке → []) ────────────────────────────


def test_complete_space_filters_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_spaces_cache(monkeypatch, [(5, "Support"), (6, "Backlog")])
    assert _complete_space("Sup") == [("5", "Support")]


def test_complete_space_swallows_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> list[tuple[int, str]]:
        raise RuntimeError("cache down")

    monkeypatch.setattr(kaiten_cache, "cached_spaces", _boom)
    assert _complete_space("x") == []


def test_complete_board_scoped_by_space(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_spaces_cache(monkeypatch, [(5, "Support")])

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
    _install_env(monkeypatch, {})

    def _boards(space_id: int | None = None) -> list[tuple[int, str]]:
        return [(7, "Board")]

    monkeypatch.setattr(kaiten_cache, "cached_boards", _boards)
    ctx = cast("typer.Context", _FakeCtx({"board": "Board"}))
    assert _board_id_from_ctx(ctx) == 7


def test_board_id_from_ctx_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_env(monkeypatch, {"KITEN_LS_BOARD_ID": "7"})
    ctx = cast("typer.Context", _FakeCtx({"board": None}))
    assert _board_id_from_ctx(ctx) == 7


class _FakeCtx:
    """Минимальный stand-in для typer.Context: только `params` для completion-хелперов."""

    def __init__(self, params: dict[str, object]) -> None:
        self.params = params
