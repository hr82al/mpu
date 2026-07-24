"""Общие тестовые двойники для `mpu kiten` — один клиент-фейк на весь пакет.

`FakeKaitenClient` и обвязка вокруг него нужны почти каждому тесту kiten (139 из 282),
поэтому живут здесь, а не копией в каждом файле — как `pg_fakes.py` для PG-тестов.
"""

from __future__ import annotations

import datetime
from collections.abc import Callable
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands.kiten import (
    LsFilters,
    _card_to_markdown,  # pyright: ignore[reportPrivateUsage]
    build_updated_window,
    card as kiten_card,
    coalesce,
    comment as kiten_comment,
    expand_recipients,
    field as kiten_field,
    ls as kiten_ls,
    move as kiten_move,
    parse_recipients,
    prepend_recipients,
    read_attachments,
    refs as kiten_refs,
    resolve_comment_text,
    resolve_ls_filters,
    status as kiten_status,
    timelog as kiten_timelog,
)
from mpu.lib import env, kaiten_cache, kaiten_links, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenBoard,
    KaitenCard,
    KaitenCardDetail,
    KaitenColumn,
    KaitenComment,
    KaitenFile,
    KaitenLane,
    KaitenMember,
    KaitenRole,
    KaitenSpace,
    KaitenTimeLog,
    KaitenTimer,
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


def test_build_multipart_custom_file_field() -> None:
    # Загрузка файла карточки: поле называется `file` (не `files[]`) + текстовый custom_property_id.
    body, _ = build_multipart(
        {"custom_property_id": "610303"}, [("a.md", b"# A")], file_field="file"
    )
    assert b'name="custom_property_id"' in body
    assert b'name="file"; filename="a.md"' in body
    assert b'name="files[]"' not in body
    assert b"# A" in body


def test_is_markdown() -> None:
    assert kiten_field._is_markdown("67531635-slug.md")
    assert kiten_field._is_markdown("UPPER.MD")
    assert not kiten_field._is_markdown("report.txt")
    assert not kiten_field._is_markdown("noext")


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


class FakeColumnsClient:
    """Мини-клиент, отдаёт фиксированный список колонок (нужен только list_columns)."""

    def __init__(self, columns: list[KaitenColumn]) -> None:
        self._columns = columns

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        _ = board_ids
        return self._columns


COMMAND_MODULES = (
    kiten_card,
    kiten_comment,
    kiten_field,
    kiten_ls,
    kiten_move,
    kiten_refs,
    kiten_status,
    kiten_timelog,
)


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
        time_logs: list[KaitenTimeLog] | None = None,
        roles: list[KaitenRole] | None = None,
        new_log_id: int = 4471,
        timer_already_running: bool = False,
        fail: set[str] | None = None,
    ) -> None:
        self.base_url = base_url
        self._user = user
        self._cards = cards if cards is not None else []
        self._details = details if details is not None else [card_detail()]
        self._comments = comments if comments is not None else []
        self._columns = columns if columns is not None else []
        self._new_comment_id = new_comment_id
        self._fail: set[str] = fail if fail is not None else set()
        self.get_card_ids: list[int] = []
        self.list_cards_kwargs: dict[str, object] = {}
        self.move_calls: list[dict[str, int | None]] = []
        self.added_comments: list[dict[str, object]] = []
        self.props_set: list[tuple[int, str, str | None]] = []
        self.uploaded_files: list[dict[str, object]] = []
        self.deleted_files: list[tuple[int, int]] = []
        self._time_logs = time_logs if time_logs is not None else []
        self._roles = roles if roles is not None else []
        self._new_log_id = new_log_id
        self._timer_already_running = timer_already_running
        self.logs_added: list[dict[str, object]] = []
        self.logs_patched: list[tuple[int, int, dict[str, object]]] = []
        self.logs_deleted: list[tuple[int, int]] = []
        self.timers_started: list[dict[str, object]] = []
        self.timers_stopped: list[dict[str, object]] = []
        self.timers_discarded: list[int] = []

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

    def upload_property_file(
        self, card_id: int, property_id: int, filename: str, content: bytes
    ) -> KaitenFile:
        self._maybe_fail("upload_property_file")
        self.uploaded_files.append(
            {
                "card_id": card_id,
                "property_id": property_id,
                "filename": filename,
                "content": content,
            }
        )
        return KaitenFile(id=555, url=f"https://files.kaiten.ru/{filename}", name=filename)

    def delete_card_file(self, card_id: int, file_id: int) -> None:
        self._maybe_fail("delete_card_file")
        self.deleted_files.append((card_id, file_id))

    # ── учёт времени ───────────────────────────────────────────────────────────

    def list_roles(self) -> list[KaitenRole]:
        self._maybe_fail("list_roles")
        return self._roles

    def list_time_logs(self, card_id: int) -> list[KaitenTimeLog]:
        self._maybe_fail("list_time_logs")
        return [log for log in self._time_logs if log.card_id == card_id]

    def add_time_log(
        self, card_id: int, *, for_date: str, minutes: int, role_id: int, comment: str = ""
    ) -> KaitenTimeLog:
        self._maybe_fail("add_time_log")
        self.logs_added.append(
            {
                "card_id": card_id,
                "for_date": for_date,
                "minutes": minutes,
                "role_id": role_id,
                "comment": comment,
            }
        )
        # Ответ POST отдаёт `for_date` ISO-полуночью и БЕЗ вложенной роли — как настоящий API.
        created = KaitenTimeLog.model_validate(
            {
                "id": self._new_log_id,
                "card_id": card_id,
                "user_id": 42,
                "role_id": role_id,
                "time_spent": minutes,
                "for_date": f"{for_date}T00:00:00.000Z",
                "comment": comment,
            }
        )
        self._time_logs.append(created)
        return created

    def update_time_log(self, card_id: int, log_id: int, body: dict[str, object]) -> KaitenTimeLog:
        self._maybe_fail("update_time_log")
        self.logs_patched.append((card_id, log_id, dict(body)))
        return next(log for log in self._time_logs if log.id == log_id)

    def delete_time_log(self, card_id: int, log_id: int) -> None:
        self._maybe_fail("delete_time_log")
        self.logs_deleted.append((card_id, log_id))
        self._time_logs = [log for log in self._time_logs if log.id != log_id]

    def start_timer(self, card_id: int, *, comment: str = "") -> KaitenTimer | None:
        self._maybe_fail("start_timer")
        self.timers_started.append({"card_id": card_id, "comment": comment})
        if self._timer_already_running:
            return None  # тело `{"message": "User timer already created"}` — без `id`
        return KaitenTimer(
            id=900, card_id=card_id, comment=comment, started_at="2026-07-20T09:00:00.000Z"
        )

    def stop_timer(
        self,
        timer_id: int,
        *,
        finished_at: str,
        started_at: str | None = None,
        comment: str | None = None,
        role_id: int | None = None,
    ) -> KaitenTimer:
        self._maybe_fail("stop_timer")
        self.timers_stopped.append(
            {
                "timer_id": timer_id,
                "finished_at": finished_at,
                "started_at": started_at,
                "comment": comment,
                "role_id": role_id,
            }
        )
        return KaitenTimer(id=timer_id, card_id=100, card_time_log_id=self._new_log_id)

    def discard_timer(self, timer_id: int) -> None:
        self._maybe_fail("discard_timer")
        self.timers_discarded.append(timer_id)


def time_log(
    *,
    log_id: int = 1,
    card_id: int = 100,
    user_id: int | None = 42,
    role_id: int | None = 12058,
    role: str | None = "Техподдержка",
    minutes: int = 60,
    for_date: str = "2026-07-20",
    comment: str = "работа",
    user: str | None = "Я",
) -> KaitenTimeLog:
    """Запись учёта времени напрямую (без сети), как её отдаёт GET списка."""
    return KaitenTimeLog(
        id=log_id,
        card_id=card_id,
        user_id=user_id,
        role_id=role_id,
        role_name=role,
        user_name=user,
        time_spent=minutes,
        for_date=for_date,
        comment=comment,
    )


def timer_payload(
    *, timer_id: int = 900, started_at: str | None = "2026-07-20T09:00:00.000Z", comment: str = ""
) -> KaitenTimer:
    return KaitenTimer(id=timer_id, card_id=100, started_at=started_at, comment=comment)


def card_detail(
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
    files: list[KaitenFile] | None = None,
    timer: KaitenTimer | None = None,
    time_spent_sum: int | None = None,
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
        timer=timer,
        time_spent_sum=time_spent_sum,
        url=f"https://btlz.kaiten.ru/{card_id}",
        tags=[],
        members=[],
        files=files or [],
        properties=properties or {},
    )


def install_client(monkeypatch: pytest.MonkeyPatch, fake: FakeKaitenClient) -> None:
    """Подменить `KaitenClient.from_env()` в модулях команд `kiten` — возвращает фейк."""

    class _Stub:
        @staticmethod
        def from_env() -> FakeKaitenClient:
            return fake

    for mod in COMMAND_MODULES:
        monkeypatch.setattr(mod, "KaitenClient", _Stub)


def install_env(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    """Подменить `env.get` словарём (изоляция от реального ~/.config/mpu/.env)."""

    def _get(name: str, default: str | None = None) -> str | None:
        return values.get(name, default)

    monkeypatch.setattr(env, "get", _get)


def patch_columns_cache(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[int, str]]) -> None:
    def _cached(board_id: int | None = None) -> list[tuple[int, str]]:
        _ = board_id
        return rows

    monkeypatch.setattr(kaiten_cache, "cached_columns", _cached)


def patch_spaces_cache(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[int, str]]) -> None:
    def _cached() -> list[tuple[int, str]]:
        return rows

    monkeypatch.setattr(kaiten_cache, "cached_spaces", _cached)


def patch_prop_names(monkeypatch: pytest.MonkeyPatch, names: dict[int, str]) -> None:
    def _names() -> dict[int, str]:
        return names

    monkeypatch.setattr(kaiten_cache, "property_names", _names)


def patch_discover(
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


def patch_lanes(
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


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Временный путь `mpu.db` + redirect `store.DB_PATH` (журнал перемещений/привязок)."""
    path = tmp_path / "kiten.db"
    monkeypatch.setattr(store, "DB_PATH", path)
    return path


def recorded_moves() -> list[kaiten_links.CardMove]:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.list_moves(conn)


def seed_link(card_id: int, field: str, value: str) -> kaiten_links.CardLink:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.record_link(conn, card_id, field, value)


def user_payload() -> KaitenUser:
    return KaitenUser(id=42, full_name="Me", username="me", email="me@x")


def card_payload(
    card_id: int = 42, *, state: int | None = 2, column_id: int | None = 10
) -> KaitenCard:
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


def patch_roles_cache(monkeypatch: pytest.MonkeyPatch, rows: list[tuple[int, str]]) -> None:
    """Кэш ролей для резолва `--role` без сети."""
    monkeypatch.setattr(kaiten_cache, "roles", lambda: rows)
    monkeypatch.setattr(kaiten_cache, "cached_roles", lambda: rows)


def freeze_now(monkeypatch: pytest.MonkeyPatch, moment: datetime.datetime) -> None:
    monkeypatch.setattr(kiten_timelog, "_now", lambda: moment)


runner = CliRunner()


def patch_columns_disc(
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


def card_links() -> list[kaiten_links.CardLink]:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.list_links(conn)


BOARD_COLS: list[tuple[int, str]] = [(10, "Очередь"), (20, "Разработка"), (30, "Готово")]

UTC = datetime.UTC

ROLES: list[tuple[int, str]] = [
    (12057, "Разработка"),
    (12058, "Техподдержка"),
    (24379, "Код-ревью"),
    (12127, "Координация"),
]
