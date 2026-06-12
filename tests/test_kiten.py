"""Тесты `mpu kiten` — только чистые функции (без сети и без моков HTTP).

I/O-клиент `KaitenClient` (_request/current_user/list_cards) тестами не покрыт —
прецедент miro/slapi. Здесь: сборка query, парсинг карточки, маппинг state,
URL и precedence фильтров (CLI > env > дефолт).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
import typer

from mpu.commands.kiten import (
    LsFilters,
    _card_to_markdown,
    build_updated_window,
    coalesce,
    resolve_comment_text,
    resolve_ls_filters,
)
from mpu.lib.kaiten import (
    KaitenCardDetail,
    KaitenComment,
    KaitenFile,
    build_cards_query,
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
from mpu.lib.kaiten_cache import filter_refs, resolve_ref


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
