"""Тесты слоя данных `mpu kiten status` (`commands/kiten/_status_data.py`).

Этапы и их нормализация, строки выдачи, правило охвата, сортировка, фильтры, сбор трёх
источников и дорезолв места по справочнику. Сети нет: клиент — фейк из
`kiten_status_fakes`, кэш справочника и env подменяются.
"""

from __future__ import annotations

from typing import Any

import pytest
from rich.cells import cell_len

from kiten_status_fakes import FakeClient, card, install_directory, install_env, row, time_log
from mpu.commands.kiten._status_data import (
    SRC_TOUCH,
    STAGE_ALIASES,
    STAGES,
    RowFilters,
    Window,
    apply_filters,
    collect,
    fill_stages,
    in_scope,
    is_escalated,
    is_touch_only,
    iso_utc,
    load_stage_overrides,
    pick_card,
    present_stages,
    resolve_stage_filter,
    sort_rows,
    source_marks,
    stage_of,
    summarise_minutes,
)
from mpu.lib import kaiten_cache
from mpu.lib.kaiten import KaitenAPIError
from mpu.lib.kaiten_models import KaitenActivity, KaitenTimeLogEntry

# ── этапы ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("column", "expected"),
    [
        ("Очередь", "Очередь"),
        ("Бэклог", "Очередь"),
        ("Назначенные", "Очередь"),
        ("На оценке", "Оценка"),
        ("В работе", "В работе"),
        ("Разработка", "В работе"),
        ("Баги", "В работе"),
        ("Эскалация", "В работе"),
        ("На ревью", "Ревью"),
        ("На согласовании", "Ревью"),
        ("Код-ревью", "Ревью"),
        ("Тестирование QA", "Тест"),
        ("Выгрузка на DEV", "DEV"),
        ("Выгружено на pred-prod", "Пред-прод"),
        ("Открыто для ФГ", "Пред-прод"),
        ("Готово", "Готово"),
        ("Тут только выполненные карточки!", "Готово"),
        ("Странная колонка", "—"),
        (None, "—"),
        ("", "—"),
    ],
)
def test_stage_of(column: str | None, expected: str) -> None:
    assert stage_of(column) == expected


@pytest.mark.parametrize(
    ("column", "expected"),
    [
        ("Готово к код-ревью", "Ревью"),
        ("Готово к тестированию QA", "Тест"),
        ("Готово к комплексному тестированию", "Тест"),
        ("Готово к выгрузке на DEV", "DEV"),
        ("Готово к выгрузке на pred-prod", "Пред-прод"),
    ],
)
def test_stage_of_gate_columns_are_not_done(column: str, expected: str) -> None:
    # «Готово к X» — гейт этапа X, а не «Готово»: иначе половина конвейера схлопнется.
    assert stage_of(column) == expected


def test_stage_of_override_wins() -> None:
    assert stage_of("Особая колонка", {"особая колонка": "Ревью"}) == "Ревью"


def test_is_escalated() -> None:
    assert is_escalated("Эскалация")
    assert not is_escalated("В работе")
    assert not is_escalated(None)


@pytest.mark.parametrize(
    ("value", "expected"), [("review", "Ревью"), ("DEV", "DEV"), ("Ревью", "Ревью")]
)
def test_resolve_stage_filter(value: str, expected: str) -> None:
    assert resolve_stage_filter(value) == expected


def test_resolve_stage_filter_unknown() -> None:
    assert resolve_stage_filter("несуществующий") is None


def test_stage_aliases_cover_every_stage() -> None:
    # Алиас на каждый этап: иначе часть конвейера нельзя выбрать `--stage`.
    assert set(STAGE_ALIASES.values()) == {stage.label for stage in STAGES}


def test_load_stage_overrides_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {"KITEN_STAGE_MAP": '{"Моя Колонка": "Тест"}'})
    assert load_stage_overrides() == {"моя колонка": "Тест"}


@pytest.mark.parametrize("raw", ["", "   ", "не json", '["список"]'])
def test_load_stage_overrides_tolerates_garbage(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    install_env(monkeypatch, {"KITEN_STAGE_MAP": raw})
    assert load_stage_overrides() == {}


# ── строки выдачи ───────────────────────────────────────────────────────────────


def test_source_marks_width_is_constant() -> None:
    """Колонка ИСТ обязана быть ровно 6 ячеек при любом наборе источников.

    Именно на этом ломалось выравнивание: `⏱` занимает 1 ячейку, а `👤` — 2.
    """
    combos: list[set[str]] = [
        set(),
        {"assigned"},
        {"time"},
        {"activity"},
        {"assigned", "time"},
        {"assigned", "time", "activity"},
    ]
    assert {cell_len(source_marks(c)) for c in combos} == {6}


def test_source_marks_positions_are_stable() -> None:
    assert source_marks({"time"}) == "  🕒  "
    assert source_marks({"assigned", "activity"}) == "👤  📝"


def test_pick_card_prefers_version_with_column_title() -> None:
    without = card(column_title=None)
    with_title = card(column_title="На ревью")
    assert pick_card(None, without) is without
    assert pick_card(without, with_title) is with_title
    assert pick_card(with_title, without) is with_title


def test_in_scope_alive_card_ignores_window() -> None:
    assert in_scope(card(updated="2020-01-01T00:00:00Z", condition=1), "2026-07-16")


def test_in_scope_archived_card_needs_window() -> None:
    fresh = card(condition=2, archived=True, updated="2026-07-20T00:00:00Z")
    old = card(condition=2, archived=True, updated="2026-01-20T00:00:00Z")
    assert in_scope(fresh, "2026-07-16")
    assert not in_scope(old, "2026-07-16")


def test_sort_rows_open_first_then_freshest() -> None:
    done = row(card(1, state=3, updated="2026-07-23T12:00:00Z"))
    old_open = row(card(2, state=2, updated="2026-07-20T00:00:00Z"))
    fresh_open = row(card(3, state=2, updated="2026-07-23T09:00:00Z"))
    assert [r.card.id for r in sort_rows([done, old_open, fresh_open])] == [3, 2, 1]


def test_closed_covers_archived_condition() -> None:
    assert row(card(state=2, condition=2)).closed
    assert row(card(state=3, condition=1)).closed
    assert not row(card(state=1, condition=1)).closed


def test_present_stages_skips_empty() -> None:
    rows = [row(stage="В работе"), row(stage="Готово")]
    assert [s.label for s in present_stages(rows)] == ["В работе", "Готово"]


def test_summarise_minutes_by_role_within_window() -> None:
    logs = [
        KaitenTimeLogEntry(
            id=1, card_id=10, time_spent=60, for_date="2026-07-22", role_name="Разработка"
        ),
        KaitenTimeLogEntry(
            id=2, card_id=11, time_spent=30, for_date="2026-07-23", role_name="Код-ревью"
        ),
        KaitenTimeLogEntry(
            id=3, card_id=12, time_spent=90, for_date="2026-01-01", role_name="Разработка"
        ),
    ]
    total, by_role = summarise_minutes(logs, "2026-07-16")
    assert total == 90  # запись из января — вне окна
    assert by_role == [("Разработка", 60), ("Код-ревью", 30)]


# ── фильтры ─────────────────────────────────────────────────────────────────────


def test_apply_filters_by_stage_and_source() -> None:
    a = row(card(1), stage="Ревью", sources={"time"})
    b = row(card(2), stage="В работе", sources={"assigned"})
    assert [r.card.id for r in apply_filters([a, b], RowFilters(stage="Ревью"))] == [1]
    assert [r.card.id for r in apply_filters([a, b], RowFilters(source="assigned"))] == [2]


def test_apply_filters_open_done_and_board() -> None:
    opened = row(card(1, state=2, board_id=900))
    done = row(card(2, state=3, board_id=901))
    assert [r.card.id for r in apply_filters([opened, done], RowFilters(only_open=True))] == [1]
    assert [r.card.id for r in apply_filters([opened, done], RowFilters(only_done=True))] == [2]
    assert [r.card.id for r in apply_filters([opened, done], RowFilters(board_id=901))] == [2]


def test_is_touch_only_needs_activity_alone() -> None:
    """«Касание» = карточка чужая: не назначена мне и время я на неё не списывал."""
    assert is_touch_only(row(card(1), sources={"activity"}))
    assert not is_touch_only(row(card(2), sources={"activity", "time"}))
    assert not is_touch_only(row(card(3), sources={"assigned", "activity"}))


def test_apply_filters_touch_finds_foreign_cards() -> None:
    # Сценарий: написал комментарий в чужую закрытую карточку — так это и находится.
    foreign = row(card(1), sources={"activity"})
    mine = row(card(2), sources={"assigned", "activity"})
    worked = row(card(3), sources={"time", "activity"})
    picked = apply_filters([foreign, mine, worked], RowFilters(source=SRC_TOUCH))
    assert [r.card.id for r in picked] == [1]


def test_apply_filters_activity_still_matches_any_touch() -> None:
    # `activity` — обычное вхождение источника, `touch` — его исключительность.
    foreign = row(card(1), sources={"activity"})
    mine = row(card(2), sources={"assigned", "activity"})
    picked = apply_filters([foreign, mine], RowFilters(source="activity"))
    assert [r.card.id for r in picked] == [1, 2]


def test_apply_filters_empty_is_identity() -> None:
    rows = [row(card(1)), row(card(2))]
    assert apply_filters(rows, RowFilters()) == rows


# ── сбор источников ─────────────────────────────────────────────────────────────


def _window(*, since_day: str = "2026-07-16") -> Window:
    return Window(
        since_day=since_day,
        since_iso=f"{since_day}T00:00:00Z",
        time_from_iso="2025-07-23T00:00:00Z",
        max_pages=3,
    )


def test_collect_merges_three_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    assigned = card(1, column_title="Очередь")
    reviewed = card(2, column_title="Код-ревью")
    touched = card(3, column_title="В работе")
    fake = FakeClient(
        cards=[assigned],
        logs=[time_log(reviewed, minutes=90)],
        activities=[
            KaitenActivity(
                id="1", created="2026-07-22T10:00:00Z", action="comment_add", card=touched
            )
        ],
    )
    collected = collect(fake, me_id=1, window=_window())  # pyright: ignore[reportArgumentType]
    by_id = {r.card.id: r for r in collected.rows}
    assert by_id[1].sources == {"assigned"}
    assert by_id[2].sources == {"time"}
    assert by_id[2].my_minutes == 90
    assert by_id[3].sources == {"activity"}


def test_collect_counts_minutes_outside_window_but_hides_card(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Годовое окно времени влияет ТОЛЬКО на сумму минут, не на состав таблицы."""
    install_env(monkeypatch, {})
    old = card(5, condition=2, archived=True, updated="2026-01-05T00:00:00Z")
    fake = FakeClient(logs=[time_log(old, minutes=40, for_date="2026-01-05")])
    collected = collect(fake, me_id=1, window=_window())  # pyright: ignore[reportArgumentType]
    assert collected.rows == []
    assert collected.logs[0].time_spent == 40


def test_collect_reports_activity_reach(monkeypatch: pytest.MonkeyPatch) -> None:
    install_env(monkeypatch, {})
    fake = FakeClient(
        activities=[
            KaitenActivity(id="1", created="2026-07-23T10:00:00Z", action="card_move"),
            KaitenActivity(id="2", created="2026-07-21T10:00:00Z", action="card_move"),
        ]
    )
    collected = collect(fake, me_id=1, window=_window())  # pyright: ignore[reportArgumentType]
    assert collected.activity_reach == "2026-07-21T10:00:00Z"


def test_iso_utc_format() -> None:
    assert iso_utc(0) == "1970-01-01T00:00:00Z"


# ── дорезолв места по справочнику ───────────────────────────────────────────────


def test_fill_stages_resolves_column_from_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Карточка из записи учёта времени приходит без `column` — только с `column_id`."""
    install_env(monkeypatch, {})
    install_directory(monkeypatch, columns=[(777, "Код-ревью")])
    rows = [row(card(1, column_title=None, column_id=777), stage="—")]
    fill_stages(rows)
    assert rows[0].stage == "Ревью"
    assert rows[0].card.column_title == "Код-ревью"


def test_fill_stages_loads_missing_board_columns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Колонки нет в кэше → догружаем справочник ЭТОЙ доски и повторяем резолв."""
    loaded: list[list[int]] = []
    cache: list[tuple[int, str]] = []

    def _columns(board_id: int | None = None) -> list[tuple[int, str]]:
        _ = board_id
        return list(cache)

    def _boards(space_id: int | None = None) -> list[tuple[int, str]]:
        _ = space_id
        return []

    def _discover(board_ids: list[int]) -> Any:
        loaded.append(board_ids)
        cache.append((777, "Эскалация"))

    install_env(monkeypatch, {})
    monkeypatch.setattr(kaiten_cache, "cached_columns", _columns)
    monkeypatch.setattr(kaiten_cache, "cached_boards", _boards)
    monkeypatch.setattr(kaiten_cache, "discover_columns_and_store", _discover)
    rows = [row(card(1, column_title=None, column_id=777, board_id=900), stage="—")]
    fill_stages(rows)
    assert loaded == [[900]]
    assert rows[0].stage == "В работе"
    assert rows[0].escalated  # «Эскалация» — флаг срочности, а не отдельный столбец


def test_fill_stages_survives_directory_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Справочник недоступен → этап «—», но строка из выдачи не пропадает."""

    def _discover(board_ids: list[int]) -> Any:
        _ = board_ids
        raise KaitenAPIError("GET", "/boards/900/columns", 500, "boom")

    install_env(monkeypatch, {})
    install_directory(monkeypatch)
    monkeypatch.setattr(kaiten_cache, "discover_columns_and_store", _discover)
    rows = [row(card(1, column_title=None, column_id=777, board_id=900), stage="—")]
    fill_stages(rows)
    assert rows[0].stage == "—"


def test_fill_stages_fills_board_from_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """У карточки из ленты активностей нет вложенных объектов места — берём доску из кэша."""
    install_env(monkeypatch, {})
    install_directory(monkeypatch, columns=[(500, "В работе")], boards=[(900, "10X Support")])
    source = card(1, board_id=900, lane_title=None)
    source = source.model_copy(update={"board_title": None})
    rows = [row(source, stage="—")]
    fill_stages(rows)
    assert rows[0].card.board_title == "10X Support"
