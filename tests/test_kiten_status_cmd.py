"""Тесты команды `mpu kiten status` (`commands/kiten/status.py`) — CLI через фейк-клиент.

Имя файла отличается от `test_kiten_status.py`: тот покрывает `lib/kiten_status.py`
(отчёт `mpu telegram status`). Здесь — разбор опций, оркестрация и все формы вывода;
слои данных и рендера покрыты в `test_kiten_status_data.py` / `_render.py`.
"""

from __future__ import annotations

import json

import pytest
from rich.cells import cell_len
from typer.testing import CliRunner

from kiten_status_fakes import BASE, FakeClient, card, install_client, my_comment, time_log
from mpu.commands.kiten import status as kiten_status
from mpu.commands.kiten._app import app
from mpu.commands.kiten._status_data import Collected, Window
from mpu.commands.kiten.status import MAX_ACTIVITY_PAGES, activity_pages
from mpu.lib.kaiten import KaitenAPIError
from mpu.lib.kaiten_models import KaitenActivity

runner = CliRunner()
DAY = 24 * 3600


# ── окно и глубина ленты ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("days", "expected"),
    [(1, 3), (7, 3), (14, 6), (30, 12), (365, MAX_ACTIVITY_PAGES)],
)
def test_activity_pages_scales_with_window(days: int, expected: int) -> None:
    # У ленты нет серверного фильтра по дате: глубина = страницы, но с потолком.
    now = 1_800_000_000
    assert activity_pages(now - days * DAY, now) == expected


def test_cli_deep_window_asks_for_more_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(cards=[card(1)])
    install_client(monkeypatch, fake)
    runner.invoke(app, ["status", "--since", "30d"])
    assert fake.max_pages == 12


def test_cli_time_window_is_independent_of_since(monkeypatch: pytest.MonkeyPatch) -> None:
    # Колонка ВРЕМЯ = всё моё время по карточке, поэтому окно учёта времени своё.
    fake = FakeClient(cards=[card(1)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status", "--since", "7d", "--time-since", "365d"])
    assert res.exit_code == 0, res.stderr
    assert fake.time_window is not None
    assert fake.time_window[0] < fake.time_window[1]


# ── выдача ──────────────────────────────────────────────────────────────────────


def test_cli_matrix_shows_all_three_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned = card(1, title="назначенная", column_title="Очередь", state=1)
    reviewed = card(2, title="чужая на ревью", column_title="Код-ревью")
    commented = card(3, title="прокомментированная", column_title="В работе")
    fake = FakeClient(
        cards=[assigned],
        logs=[time_log(reviewed)],
        activities=[
            KaitenActivity(
                id="1", created="2026-07-22T10:00:00Z", action="comment_add", card=commented
            )
        ],
        comments={3: [my_comment()]},
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status", "--since", "3650d"])
    assert res.exit_code == 0, res.stderr
    for fragment in ("назначенная", "чужая на ревью", "прокомментированная"):
        assert fragment in res.stdout


def test_cli_json_marks_source_and_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    reviewed = card(2, title="чужая", column_title="Код-ревью")
    install_client(monkeypatch, FakeClient(logs=[time_log(reviewed, minutes=90)]))
    res = runner.invoke(app, ["status", "--since", "3650d", "--out", "json"])
    assert res.exit_code == 0, res.stderr
    rows = json.loads(res.stdout)
    assert rows[0]["sources"] == ["time"]  # не участник — только время
    assert rows[0]["my_minutes"] == 90
    assert rows[0]["stage"] == "Ревью"


def test_cli_group_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient(cards=[card(1, title="в работе")]))
    res = runner.invoke(app, ["status", "--out", "group"])
    assert res.exit_code == 0, res.stderr
    assert "▸ В работе" in res.stdout


def test_cli_group_mode_aligns_rows_with_escalation_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """Флаг 🔥 занимает две ячейки — колонки в групповом виде не должны съезжать."""
    fake = FakeClient(
        cards=[
            card(67619846, title="горит", column_title="Эскалация"),
            card(67619847, title="обычная", column_title="В работе"),
        ]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status", "--out", "group"])
    assert res.exit_code == 0, res.stderr
    body = [line for line in res.stdout.splitlines() if "горит" in line or "обычная" in line]
    assert len(body) == 2
    starts = {cell_len(line[: line.index("сегодня")]) for line in body}
    assert len(starts) == 1  # обе строки доходят до колонки даты за одинаковое число ячеек


def test_cli_url_and_md_outputs(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient(cards=[card(1, title="карточка")]))
    urls = runner.invoke(app, ["status", "--out", "url"])
    assert urls.exit_code == 0, urls.stderr
    assert urls.stdout.strip() == f"[карточка]({BASE}/1)"
    md = runner.invoke(app, ["status", "--out", "md"])
    assert md.exit_code == 0, md.stderr
    assert md.stdout.startswith("| ID | ЭТАП |")


def test_cli_format_template(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient(cards=[card(1, title="T", column_title="Код-ревью")]))
    res = runner.invoke(app, ["status", "--format", "{id} {stage} {title}"])
    assert res.exit_code == 0, res.stderr
    assert res.stdout.strip() == "1 Ревью T"


def test_cli_only_open_and_done(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(cards=[card(1, state=2), card(2, state=3)])
    install_client(monkeypatch, fake)
    opened = runner.invoke(app, ["status", "--only", "open", "--out", "json"])
    done = runner.invoke(app, ["status", "--only", "done", "--out", "json"])
    assert [r["id"] for r in json.loads(opened.stdout)] == [1]
    assert [r["id"] for r in json.loads(done.stdout)] == [2]


def test_cli_source_touch_finds_foreign_card(monkeypatch: pytest.MonkeyPatch) -> None:
    """Комментарий в чужой закрытой карточке — единственный способ его заметить."""
    mine = card(1, title="моя")
    foreign = card(2, title="чужая", condition=2, archived=True, state=3)
    fake = FakeClient(
        cards=[mine],
        activities=[
            KaitenActivity(
                id="1", created="2026-07-23T10:00:00Z", action="comment_add", card=foreign
            )
        ],
        comments={2: [my_comment()]},
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status", "--source", "touch", "--out", "json"])
    assert res.exit_code == 0, res.stderr
    assert [r["id"] for r in json.loads(res.stdout)] == [2]


def test_cli_footer_counts_touch_only_cards(monkeypatch: pytest.MonkeyPatch) -> None:
    """Одинокий 📝 в длинной таблице глазом не ловится — подвал называет число."""
    foreign = card(2, title="чужая")
    fake = FakeClient(
        cards=[card(1)],
        activities=[
            KaitenActivity(
                id="1", created="2026-07-23T10:00:00Z", action="comment_add", card=foreign
            )
        ],
        comments={2: [my_comment()]},
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status"])
    assert res.exit_code == 0, res.stderr
    assert "📝 без участия и времени: 1" in res.stdout


def test_cli_footer_silent_without_touch_only(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient(cards=[card(1)]))
    res = runner.invoke(app, ["status"])
    assert "без участия и времени" not in res.stdout


def test_cli_stage_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(cards=[card(1, column_title="Код-ревью"), card(2, column_title="В работе")])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["status", "--stage", "review", "--out", "json"])
    assert [r["id"] for r in json.loads(res.stdout)] == [1]


def test_cli_empty_result(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient())
    res = runner.invoke(app, ["status"])
    assert res.exit_code == 0, res.stderr
    assert "(нет карточек)" in res.stdout


# ── ошибки и предупреждения ─────────────────────────────────────────────────────


def test_cli_unknown_stage_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeClient())
    res = runner.invoke(app, ["status", "--stage", "чепуха"])
    assert res.exit_code == 1
    assert "неизвестный этап" in res.stderr


@pytest.mark.parametrize("flag", ["--since", "--time-since"])
def test_cli_bad_window_names_the_option(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    install_client(monkeypatch, FakeClient())
    res = runner.invoke(app, ["status", flag, "позавчера"])
    assert res.exit_code == 1
    assert flag in res.stderr


def test_cli_api_error_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(
        monkeypatch, FakeClient(error=KaitenAPIError("GET", "/users/current", 401, "Unauthorized"))
    )
    res = runner.invoke(app, ["status"])
    assert res.exit_code == 1
    assert "kaiten error" in res.stderr


def test_cli_warns_when_activity_feed_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    # Лента оборвалась раньше края окна — выдача неполна, и об этом обязано быть сказано.
    fresh = KaitenActivity(id="1", created="2026-07-23T10:00:00Z", action="card_move", card=card(9))
    install_client(monkeypatch, FakeClient(cards=[card(1)], activities=[fresh]))
    res = runner.invoke(app, ["status", "--since", "30d"])
    assert res.exit_code == 0, res.stderr
    assert "лента действий прочитана только до" in res.stderr


def test_warn_activity_reach_silent_when_window_covered() -> None:
    window = Window(
        since_day="2026-07-16",
        since_iso="2026-07-16T00:00:00Z",
        time_from_iso="2025-07-16T00:00:00Z",
        max_pages=3,
    )
    collected = Collected(rows=[], logs=[], activity_reach="2026-07-01T00:00:00Z")
    kiten_status.warn_activity_reach(collected, window)
