"""Тесты слоя вывода `mpu kiten status` (`commands/kiten/_status_render.py`).

Форматирование ячеек, склонение, подпись места, три ступени раскладки под ширину
терминала и машинные форматы. Ни сети, ни кэша: всё чистое.
"""

from __future__ import annotations

import pytest

from kiten_status_fakes import card, row
from mpu.commands.kiten._status_data import STAGES
from mpu.commands.kiten._status_render import (
    GROUP_TITLE_WIDTH,
    MIN_GROUP_TITLE,
    format_minutes,
    format_row,
    group_title_budget,
    id_cell,
    lane_cell,
    plan_layout,
    plural_cards,
    row_dict,
    rows_to_md_table,
    short_date,
)

# ── ячейки ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("minutes", "expected"), [(0, "—"), (-5, "—"), (45, "45м"), (60, "1ч00м"), (317, "5ч17м")]
)
def test_format_minutes(minutes: int, expected: str) -> None:
    assert format_minutes(minutes) == expected


@pytest.mark.parametrize(
    ("count", "expected"),
    [
        (0, "карточек"),
        (1, "карточка"),
        (3, "карточки"),
        (5, "карточек"),
        (11, "карточек"),
        (12, "карточек"),
        (21, "карточка"),
        (22, "карточки"),
        (25, "карточек"),
        (111, "карточек"),
    ],
)
def test_plural_cards(count: int, expected: str) -> None:
    assert plural_cards(count) == expected


@pytest.mark.parametrize(
    ("iso", "expected"),
    [
        ("2026-07-23T10:00:00Z", "сегодня"),
        ("2026-07-22T10:00:00Z", "вчера"),
        ("2026-07-21T10:00:00Z", "07.21"),
        (None, "—"),
        ("", "—"),
    ],
)
def test_short_date(iso: str | None, expected: str) -> None:
    assert short_date(iso, "2026-07-23") == expected


def test_lane_cell_prefers_lane_then_space_then_board() -> None:
    """У support-карточек дорожки нет, а имя доски служебное — пространство информативнее."""
    with_lane = row(card(lane_title="Веб-разработка"))
    assert lane_cell(with_lane) == "Веб-разработка"

    no_lane = card(lane_title=None).model_copy(
        update={"space_title": "10Х Support", "board_title": "Не использовать!"}
    )
    assert lane_cell(row(no_lane)) == "10Х Support"

    only_board = card(lane_title=None).model_copy(update={"board_title": "Дорожная карта"})
    assert lane_cell(row(only_board)) == "Дорожная карта"


def test_id_cell_link_and_escalation_marker() -> None:
    plain = row(card(42))
    assert id_cell(plain, link=False) == "42"
    assert id_cell(plain, link=True) == "[link=https://btlz.kaiten.ru/42]42[/link]"
    assert id_cell(row(card(42), escalated=True), link=False) == "🔥42"


# ── раскладка ───────────────────────────────────────────────────────────────────


def test_plan_layout_wide_terminal_keeps_full_headers() -> None:
    layout = plan_layout(200, list(STAGES[:4]), id_width=9)
    assert layout.headers == ["Очередь", "Оценка", "В работе", "Ревью"]
    assert layout.show_lane
    assert layout.legend == ""
    assert layout.title_budget >= 24


def test_plan_layout_shortens_headers_when_narrow() -> None:
    layout = plan_layout(140, list(STAGES), id_width=9)
    assert layout.headers == [s.short for s in STAGES]
    assert layout.show_lane


def test_plan_layout_falls_back_to_letters_with_legend() -> None:
    layout = plan_layout(120, list(STAGES), id_width=9)
    assert layout.headers == [s.letter for s in STAGES]
    assert "О=Очередь" in layout.legend


def test_plan_layout_drops_lane_only_after_headers_shrunk() -> None:
    """Дорожкой жертвуем ПОСЛЕДНЕЙ: на 120 она ещё есть (заголовки уже буквы), на 110 — нет."""
    with_lane = plan_layout(120, list(STAGES), id_width=9)
    without_lane = plan_layout(110, list(STAGES), id_width=9)
    assert with_lane.show_lane
    assert with_lane.headers == [s.letter for s in STAGES]
    assert not without_lane.show_lane


def test_plan_layout_survives_absurdly_narrow_terminal() -> None:
    # Последний вариант отдаётся даже если места нет: заголовок просто схлопнется в пусто.
    layout = plan_layout(20, list(STAGES), id_width=9)
    assert layout.headers == [s.letter for s in STAGES]
    assert not layout.show_lane


def test_group_title_budget_follows_console_width() -> None:
    """Групповой вид тоже обязан влезать в терминал — иначе строка рвётся надвое."""
    assert group_title_budget(200, 10) == GROUP_TITLE_WIDTH  # шире потолка не растём
    narrow = group_title_budget(100, 10)
    assert MIN_GROUP_TITLE <= narrow < GROUP_TITLE_WIDTH
    assert group_title_budget(40, 10) == MIN_GROUP_TITLE  # ниже пола не опускаемся


# ── машинные форматы ────────────────────────────────────────────────────────────


def test_format_row_template() -> None:
    source = row(card(7, title="T"), stage="Ревью", my_minutes=90)
    assert (
        format_row("{n}|{id}|{stage}|{min}|{title}|{lane}", 1, source)
        == "1|7|Ревью|90|T|Веб-разработка"
    )


def test_row_dict_exposes_place_and_sources() -> None:
    payload = row_dict(row(card(7), stage="Ревью", sources={"time"}, my_minutes=15))
    assert payload["id"] == 7
    assert payload["stage"] == "Ревью"
    assert payload["sources"] == ["time"]
    assert payload["my_minutes"] == 15
    assert payload["closed"] is False


def test_rows_to_md_table_escapes_pipes() -> None:
    table = rows_to_md_table([row(card(7, title="A | B"), stage="Ревью")], "2026-07-23")
    lines = table.splitlines()
    assert lines[0].startswith("| ID | ЭТАП |")
    assert r"A \| B" in lines[2]
