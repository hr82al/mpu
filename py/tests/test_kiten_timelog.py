"""Тесты `mpu kiten time` — учёт времени и таймер.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import datetime
import json
import time
from pathlib import Path
from typing import Any, cast

import pytest
import typer

from kiten_fakes import (
    BOARD_COLS,
    COMMAND_MODULES,
    ROLES,
    UTC,
    FakeKaitenClient,
    card_detail,
    card_payload,
    freeze_now,
    install_client,
    install_env,
    patch_columns_cache,
    patch_roles_cache,
    runner,
    time_log,
    timer_payload,
    user_payload,
)
from mpu.commands.kiten import (
    _resolve_role,  # pyright: ignore[reportPrivateUsage]
    app,
    build_time_log_patch,
    default_for_date,
    refs as kiten_refs,
    summarise_logs,
    timelog as kiten_timelog,
)
from mpu.lib import kaiten_cache, kaiten_links, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenCardDetail,
    KaitenRole,
    KaitenTimeLog,
    KaitenTimer,
)
from mpu.lib.kaiten_cache import (
    KaitenRolesResult,
)
from mpu.lib.kiten_status import MSK

# --- default_for_date: день по Москве, не по локальной зоне -------------------


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        (datetime.datetime(2026, 7, 20, 23, 59, tzinfo=MSK), "2026-07-20"),
        (datetime.datetime(2026, 7, 21, 0, 30, tzinfo=MSK), "2026-07-21"),
        # 21:30 UTC = 00:30 МСК следующего дня → берём московский день
        (datetime.datetime(2026, 7, 20, 21, 30, tzinfo=UTC), "2026-07-21"),
        # 20:30 UTC = 23:30 МСК того же дня
        (datetime.datetime(2026, 7, 20, 20, 30, tzinfo=UTC), "2026-07-20"),
    ],
)
def test_default_for_date_uses_msk(moment: datetime.datetime, expected: str) -> None:
    assert default_for_date(moment) == expected


# --- нормализация for_date: срез, а не конвертация зоны -----------------------


@pytest.mark.parametrize(
    ("wire", "expected"),
    [
        ("2026-07-20", "2026-07-20"),  # форма GET списка
        ("2026-07-20T00:00:00.000Z", "2026-07-20"),  # форма ответа POST/PATCH
        ("", ""),
    ],
)
def test_for_date_normalised(wire: str, expected: str) -> None:
    log = KaitenTimeLog.model_validate({"id": 1, "card_id": 100, "for_date": wire})
    assert log.for_date == expected


def test_for_date_never_shifts_with_local_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    # Регресс: ISO-полночь UTC, разобранная как инстант и переведённая в UTC-5, дала бы
    # предыдущий день. Срез первых 10 символов от зоны машины не зависит.
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    try:
        log = KaitenTimeLog.model_validate(
            {"id": 1, "card_id": 100, "for_date": "2026-07-20T00:00:00.000Z"}
        )
        assert log.for_date == "2026-07-20"
    finally:
        monkeypatch.delenv("TZ", raising=False)
        time.tzset()


def test_time_log_drops_avatar_bearing_objects() -> None:
    # Вложенные user/author несут base64-PNG (~4 КБ). Модель обязана оставить от них
    # только плоские имена — иначе они утекут в `--json`.
    log = KaitenTimeLog.model_validate(
        {
            "id": 1,
            "card_id": 100,
            "time_spent": 60,
            "role": {"id": 12058, "name": "Техподдержка"},
            "user": {
                "id": 42,
                "full_name": "Я",
                "avatar_initials_url": "data:image/png;base64,AAA",
            },
            "author": {"id": 42, "avatar_initials_url": "data:image/png;base64,BBB"},
        }
    )
    assert log.role_name == "Техподдержка"
    assert log.user_name == "Я"
    assert "avatar" not in log.model_dump_json()


def test_time_log_tolerates_null_comment() -> None:
    # Очищенный комментарий приходит как null — не должен ронять разбор.
    log = KaitenTimeLog.model_validate({"id": 1, "card_id": 100, "comment": None})
    assert log.comment == ""


# --- elapsed_minutes: округление вверх, паритет с сервером --------------------


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [(0, 0), (20, 1), (59, 1), (60, 1), (61, 2), (3600, 60)],
)
def test_elapsed_minutes_rounds_up(seconds: int, expected: int) -> None:
    start = datetime.datetime(2026, 7, 20, 9, 0, tzinfo=UTC)
    now = start + datetime.timedelta(seconds=seconds)
    assert kiten_timelog.elapsed_minutes("2026-07-20T09:00:00.000Z", now) == expected


# --- timer_window: какие метки уходят в PATCH ---------------------------------


def test_timer_window_without_time_sends_only_finish() -> None:
    now = datetime.datetime(2026, 7, 20, 12, 34, 56, tzinfo=UTC)
    start_at, finish_at = kiten_timelog.timer_window("2026-07-20T09:00:00.000Z", now, None)
    assert start_at is None  # старт не трогаем — длительность считает сервер
    assert finish_at == "2026-07-20T12:34:56.000Z"


def test_timer_window_with_time_keeps_start_like_web_ui() -> None:
    # Живой сценарий: натикало 4:12, записываем 1:15 → старт сохранён (усечён до минуты),
    # финиш = старт + 75 мин. Ровно это отправляет веб-интерфейс.
    now = datetime.datetime(2026, 7, 20, 15, 53, 30, tzinfo=UTC)
    start_at, finish_at = kiten_timelog.timer_window("2026-07-20T11:41:38.289Z", now, 75)
    assert start_at == "2026-07-20T11:41:00.000Z"
    assert finish_at == "2026-07-20T12:56:00.000Z"


def test_timer_window_clamps_future_finish_to_now() -> None:
    # Заявили больше, чем натикало: финиш «старт + N» ушёл бы в будущее → якорь на «сейчас»,
    # назад сдвигается старт. Будущей метки у записи быть не должно.
    now = datetime.datetime(2026, 7, 20, 9, 10, 0, tzinfo=UTC)
    start_at, finish_at = kiten_timelog.timer_window("2026-07-20T09:00:00.000Z", now, 60)
    assert finish_at == "2026-07-20T09:10:00.000Z"
    assert start_at == "2026-07-20T08:10:00.000Z"


def test_timer_window_preserves_source_timezone() -> None:
    # Регресс: арифметика в наивных МСК-терминах поверх метки со смещением увела бы запись.
    now = datetime.datetime(2026, 7, 20, 9, 0, 0, tzinfo=UTC)
    start_at, finish_at = kiten_timelog.timer_window("2026-07-20T11:00:00+03:00", now, 30)
    assert start_at == "2026-07-20T11:00:00.000+03:00"
    assert finish_at == "2026-07-20T11:30:00.000+03:00"


def test_timer_window_milliseconds_always_zero() -> None:
    # Лишняя `.001` при серверном округлении вверх превратила бы N минут в N+1.
    now = datetime.datetime(2026, 7, 20, 9, 30, 0, 500_000, tzinfo=UTC)
    _, finish_at = kiten_timelog.timer_window("2026-07-20T09:00:00.123Z", now, None)
    assert finish_at.endswith(".000Z")


# --- summarise_logs / build_time_log_patch ------------------------------------


def test_summarise_logs_filters_and_totals() -> None:
    logs = [
        time_log(log_id=1, user_id=42, minutes=60, for_date="2026-07-19"),
        time_log(log_id=2, user_id=99, minutes=30, for_date="2026-07-20"),  # чужая
        time_log(log_id=3, user_id=42, minutes=15, for_date="2026-07-20", role_id=12057),
    ]
    mine, total = summarise_logs(logs, user_id=42)
    assert [log.id for log in mine] == [1, 3]
    assert total == 75

    everyone, total_all = summarise_logs(logs)
    assert len(everyone) == 3
    assert total_all == 105

    windowed, _ = summarise_logs(logs, date_from="2026-07-20", date_to="2026-07-20")
    assert [log.id for log in windowed] == [2, 3]

    by_role, _ = summarise_logs(logs, role_id=12057)
    assert [log.id for log in by_role] == [3]


def test_summarise_logs_empty() -> None:
    assert summarise_logs([]) == ([], 0)


def test_build_time_log_patch_only_given_axes() -> None:
    assert build_time_log_patch(minutes=75) == {"time_spent": 75}
    assert build_time_log_patch(comment="") == {"comment": ""}  # пустая строка = очистка
    assert build_time_log_patch(minutes=75, for_date="2026-07-19", role_id=12057) == {
        "time_spent": 75,
        "for_date": "2026-07-19",
        "role_id": 12057,
    }


def test_build_time_log_patch_rejects_empty() -> None:
    with pytest.raises(ValueError, match="нечего обновлять"):
        build_time_log_patch()


# --- резолв роли --------------------------------------------------------------


def test_resolve_role_by_name_substring_and_id(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    assert _resolve_role("Техподдержка") == 12058
    assert _resolve_role("техпод") == 12058
    assert _resolve_role("12057") == 12057


def test_resolve_role_default_is_support(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    assert _resolve_role(None) == 12058


def test_resolve_role_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {"KITEN_TIME_ROLE": "Код-ревью"})
    assert _resolve_role(None) == 24379


def test_resolve_role_bad_env_does_not_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    # Тихий откат на дефолт списывал бы время не на ту роль при опечатке в .env.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {"KITEN_TIME_ROLE": "нет такой"})
    with pytest.raises(typer.BadParameter, match="KITEN_TIME_ROLE"):
        _resolve_role(None)


def test_resolve_role_ambiguous_lists_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    with pytest.raises(typer.BadParameter) as exc:
        _resolve_role("ко")
    msg = str(exc.value)
    assert "Код-ревью" in msg
    assert "Координация" in msg


def test_resolve_role_numeric_works_without_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    # Оффлайн-лазейка: пустой кэш + числовой ID всё равно резолвится.
    patch_roles_cache(monkeypatch, [])
    assert _resolve_role("12058") == 12058


# --- CLI: записи --------------------------------------------------------------


def _freeze_today(monkeypatch: pytest.MonkeyPatch, day: str = "2026-07-20") -> None:
    def _today(_now: datetime.datetime | None = None) -> str:
        return day

    monkeypatch.setattr(kiten_timelog, "default_for_date", _today)


def test_time_add_posts_minutes_and_msk_today(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    _freeze_today(monkeypatch)
    fake = FakeKaitenClient(user=user_payload())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "add", "100", "1:15", "-m", "разбор"])
    assert res.exit_code == 0, res.stderr
    assert fake.logs_added == [
        {
            "card_id": 100,
            "for_date": "2026-07-20",
            "minutes": 75,  # МИНУТЫ, целым числом — единица API
            "role_id": 12058,
            "comment": "разбор",
        }
    ]
    assert "+1 ч 15 мин" in res.output
    # for_date из ответа POST приходит ISO-полуночью — печатать надо нормализованным
    assert "2026-07-20" in res.output
    assert "T00:00:00" not in res.output


def test_time_add_explicit_date_and_role(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    _freeze_today(monkeypatch)
    fake = FakeKaitenClient(user=user_payload())
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app, ["time", "add", "100", "3h", "--date", "2026-07-19", "--role", "разработка"]
    )
    assert res.exit_code == 0, res.stderr
    assert fake.logs_added[0]["for_date"] == "2026-07-19"
    assert fake.logs_added[0]["role_id"] == 12057
    assert fake.logs_added[0]["minutes"] == 180


def test_time_add_future_date_warns_but_succeeds(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    _freeze_today(monkeypatch)
    fake = FakeKaitenClient(user=user_payload())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "add", "100", "1h", "--date", "2027-07-19"])
    assert res.exit_code == 0, res.stderr
    assert "в будущем" in res.stderr
    assert fake.logs_added


def test_time_add_bad_duration_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    fake = FakeKaitenClient(user=user_payload())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "add", "100", "1h15"])
    assert res.exit_code == 2
    assert not fake.logs_added


def test_time_add_dry_run_writes_nothing(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    _freeze_today(monkeypatch)
    fake = FakeKaitenClient(user=user_payload())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "add", "100", "1h", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert res.output.startswith("dry-run:")
    assert not fake.logs_added


def test_time_add_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    _freeze_today(monkeypatch)
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), fail={"add_time_log"}))
    res = runner.invoke(app, ["time", "add", "100", "1h"])
    assert res.exit_code == 1
    assert "time add: kaiten error" in res.stderr


def test_time_ls_mine_only_by_default(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    logs = [time_log(log_id=1, user_id=42), time_log(log_id=2, user_id=99, user="Коллега")]
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=logs))
    res = runner.invoke(app, ["time", "ls", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert [log["id"] for log in payload["logs"]] == [1]
    assert payload["total_minutes"] == 60


def test_time_ls_all_includes_others(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    logs = [time_log(log_id=1, user_id=42), time_log(log_id=2, user_id=99, user="Коллега")]
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=logs))
    res = runner.invoke(app, ["time", "ls", "100", "--all"])
    assert res.exit_code == 0, res.stderr
    assert "Коллега" in res.output
    assert "итого: 2 ч (2 записи)" in res.output


def test_time_ls_output_carries_no_avatars(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=[time_log()]))
    res = runner.invoke(app, ["time", "ls", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    assert "avatar" not in res.output
    assert "base64" not in res.output


def test_time_ls_empty(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["time", "ls", "100"])
    assert res.exit_code == 0, res.stderr
    assert "(пусто)" in res.output


def test_time_ls_date_window(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    logs = [
        time_log(log_id=1, for_date="2026-07-18"),
        time_log(log_id=2, for_date="2026-07-20"),
    ]
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=logs))
    res = runner.invoke(app, ["time", "ls", "100", "--date-from", "2026-07-19", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert [log["id"] for log in payload["logs"]] == [2]


def test_time_edit_sends_only_given_axes(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "edit", "100", "7", "--time", "2:00"])
    assert res.exit_code == 0, res.stderr
    assert fake.logs_patched == [(100, 7, {"time_spent": 120})]


def test_time_edit_all_axes(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app,
        [
            "time",
            "edit",
            "100",
            "7",
            "--time",
            "30m",
            "--date",
            "2026-07-19",
            "--role",
            "разработка",
            "-m",
            "новое",
        ],
    )
    assert res.exit_code == 0, res.stderr
    assert fake.logs_patched[0][2] == {
        "time_spent": 30,
        "for_date": "2026-07-19",
        "role_id": 12057,
        "comment": "новое",
    }


def test_time_edit_empty_comment_clears(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    # Пустая строка — осмысленное значение (очистка), в отличие от отсутствия флага.
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "edit", "100", "7", "-m", ""])
    assert res.exit_code == 0, res.stderr
    assert fake.logs_patched[0][2] == {"comment": ""}
    assert "комментарий очищен" in res.output


def test_time_edit_without_axes_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "edit", "100", "7"])
    assert res.exit_code == 2
    assert not fake.logs_patched


def test_time_edit_missing_log_hints_ls(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    )
    res = runner.invoke(app, ["time", "edit", "100", "999", "--time", "1h"])
    assert res.exit_code == 1
    assert "time ls 100" in res.stderr


def test_time_edit_foreign_log_blocked_and_forced(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7, user_id=99)])
    install_client(monkeypatch, fake)
    blocked = runner.invoke(app, ["time", "edit", "100", "7", "--time", "1h"])
    assert blocked.exit_code == 1
    assert "другому пользователю" in blocked.stderr
    assert not fake.logs_patched

    forced = runner.invoke(app, ["time", "edit", "100", "7", "--time", "1h", "--force"])
    assert forced.exit_code == 0, forced.stderr
    assert fake.logs_patched


def test_time_rm_prints_deleted_record(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(
        user=user_payload(), time_logs=[time_log(log_id=7, comment="разбор жалобы")]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "rm", "100", "7"])
    assert res.exit_code == 0, res.stderr
    assert fake.logs_deleted == [(100, 7)]
    # удалённое печатается целиком — дешёвая страховка от опечатки в ID
    assert "разбор жалобы" in res.output
    assert "1 ч" in res.output


def test_time_rm_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "rm", "100", "7", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert not fake.logs_deleted


# --- CLI: таймер --------------------------------------------------------------


def test_time_start_records_hint_with_role(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100", "--role", "разработка", "-m", "правлю"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_started == [{"card_id": 100, "comment": "правлю"}]
    # Роль API таймера не хранит — держим её локально до остановки
    with store.store() as conn:
        store.bootstrap(conn)
        hint = kaiten_links.get_time_hint(conn, 100)
    assert hint is not None
    assert hint.role_id == 12057
    assert hint.timer_id == 900


def test_time_start_when_already_running_here(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 1
    assert "уже запущен" in res.stderr
    assert not fake.timers_started


def test_time_start_when_server_says_already_created(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Гонка между pre-GET и POST: сервер отвечает телом `{"message": ...}` без `id`.
    # Ветвимся по ФОРМЕ ответа, а не по HTTP-статусу — и не падаем на отсутствующем поле.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(
        user=user_payload(), details=[card_detail(timer=None)], timer_already_running=True
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 1
    assert "уже создан" in res.stderr


def test_time_start_blocked_by_verified_timer_elsewhere(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(
            conn, 555, timer_id=901, started_at="2026-07-20T09:00:00.000Z"
        )
    # get_card: сперва целевая карточка (без таймера), затем 555 — с таймером,
    # что подтверждает подсказку.
    fake = FakeKaitenClient(
        user=user_payload(),
        details=[
            card_detail(card_id=100, timer=None),
            card_detail(card_id=555, timer=timer_payload()),
        ],
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 1
    assert "555" in res.stderr
    assert not fake.timers_started


def test_time_start_clears_stale_hint_and_proceeds(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Подсказка говорит «таймер на 555», сервер — «нет». Молча чистим и работаем дальше:
    # блокировать по неподтверждённому локальному состоянию нельзя.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(
            conn, 555, timer_id=901, started_at="2026-07-20T09:00:00.000Z"
        )
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(card_id=100, timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_started
    with store.store() as conn:
        stale = kaiten_links.get_time_hint(conn, 555)
    assert stale is not None
    assert stale.timer_id is None  # сведения о таймере убраны


def test_time_start_force_ignores_other_card(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 555, timer_id=901)
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(card_id=100, timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100", "--force"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_started


def test_time_status_running(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 15, tzinfo=UTC))
    detail = card_detail(timer=timer_payload(comment="правлю"), time_spent_sum=255)
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), details=[detail]))
    res = runner.invoke(app, ["time", "status", "100"])
    assert res.exit_code == 0, res.stderr
    assert "идёт 1 ч 15 мин" in res.output
    assert "правлю" in res.output
    assert "всего по карточке: 4 ч 15 мин" in res.output


def test_time_status_idle_is_not_an_error(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(
        monkeypatch,
        FakeKaitenClient(user=user_payload(), details=[card_detail(timer=None, time_spent_sum=0)]),
    )
    res = runner.invoke(app, ["time", "status", "100"])
    assert res.exit_code == 0  # status — запрос, а не действие
    assert "не запущен" in res.output


def test_time_status_json(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 9, 30, tzinfo=UTC))
    detail = card_detail(timer=timer_payload(), time_spent_sum=60)
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), details=[detail]))
    res = runner.invoke(app, ["time", "status", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert payload["timer"]["elapsed_minutes"] == 30
    assert payload["total_minutes"] == 60


def test_time_status_without_selector_uses_hint(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 9, 30, tzinfo=UTC))
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 100, timer_id=900)
    install_client(
        monkeypatch,
        FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())]),
    )
    res = runner.invoke(app, ["time", "status"])
    assert res.exit_code == 0, res.stderr
    assert "идёт" in res.output


def test_time_status_without_selector_and_hint(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["time", "status"])
    assert res.exit_code == 0
    assert "не знаю ни об одном" in res.output


def test_time_stop_without_time_sends_only_finish(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    created = time_log(log_id=4471, minutes=60)
    fake = FakeKaitenClient(
        user=user_payload(), details=[card_detail(timer=timer_payload())], time_logs=[created]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    call = fake.timers_stopped[0]
    assert call["started_at"] is None  # длительность считает сервер
    assert call["finished_at"] == "2026-07-20T10:00:00.000Z"
    assert call["role_id"] == 12058


def test_time_stop_with_time_shifts_timestamps(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 13, 12, tzinfo=UTC))
    created = time_log(log_id=4471, minutes=75)
    fake = FakeKaitenClient(
        user=user_payload(), details=[card_detail(timer=timer_payload())], time_logs=[created]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100", "--time", "1:15"])
    assert res.exit_code == 0, res.stderr
    call = fake.timers_stopped[0]
    assert call["started_at"] == "2026-07-20T09:00:00.000Z"
    assert call["finished_at"] == "2026-07-20T10:15:00.000Z"
    assert "(по факту 4 ч 12 мин)" in res.output


def test_time_stop_carries_start_comment(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    # Комментарий записи сервер берёт из тела PATCH, а не из самого таймера: не пошлёшь —
    # текст, набранный при `start`, молча пропадёт.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    fake = FakeKaitenClient(
        user=user_payload(),
        details=[card_detail(timer=timer_payload(comment="работа по карточке"))],
        time_logs=[time_log(log_id=4471)],
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_stopped[0]["comment"] == "работа по карточке"


def test_time_stop_reads_back_created_log(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    # Печатаем факт сервера, а не свой расчёт: дату он берёт от finished_at в UTC.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    created = time_log(log_id=4471, minutes=99, for_date="2026-07-19", comment="с сервера")
    fake = FakeKaitenClient(
        user=user_payload(), details=[card_detail(timer=timer_payload())], time_logs=[created]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    assert "1 ч 39 мин" in res.output  # 99 минут с сервера, а не вычисленные нами
    assert "2026-07-19" in res.output


def test_time_stop_warns_on_utc_date_shift(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    # Остановка в 00:30 МСК = 21:30 UTC предыдущего дня → запись ляжет на вчера.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 21, 30, tzinfo=UTC))
    created = time_log(log_id=4471, for_date="2026-07-20")
    fake = FakeKaitenClient(
        user=user_payload(), details=[card_detail(timer=timer_payload())], time_logs=[created]
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    assert "по UTC" in res.stderr
    assert "2026-07-21" in res.stderr


def test_time_stop_without_timer_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 1  # тихий успех означал бы потерянную работу
    assert "time start 100" in res.stderr
    assert not fake.timers_stopped


def test_time_stop_uses_role_from_start_hint(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 100, timer_id=900, role_id=24379)
    fake = FakeKaitenClient(
        user=user_payload(),
        details=[card_detail(timer=timer_payload())],
        time_logs=[time_log(log_id=4471)],
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_stopped[0]["role_id"] == 24379  # выбранная при start, не дефолт


def test_time_stop_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert not fake.timers_stopped


def test_time_discard_removes_timer(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 100, timer_id=900)
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "discard", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_discarded == [900]
    with store.store() as conn:
        hint = kaiten_links.get_time_hint(conn, 100)
    assert hint is not None
    assert hint.timer_id is None


def test_time_discard_is_idempotent(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "discard", "100"])
    assert res.exit_code == 0  # «убедиться, что таймер не идёт» — успех
    assert "нечего сбрасывать" in res.output
    assert not fake.timers_discarded


# --- CLI: roles, сводка, close ------------------------------------------------


def _patch_roles_discover(monkeypatch: pytest.MonkeyPatch, result: KaitenRolesResult) -> None:
    monkeypatch.setattr(kaiten_cache, "discover_roles_and_store", lambda: result)
    monkeypatch.setattr(kiten_refs.kaiten_cache, "discover_roles_and_store", lambda: result)


def test_roles_hides_system_role_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    roles = [KaitenRole(id=-1, name="Employee"), KaitenRole(id=12058, name="Техподдержка")]
    _patch_roles_discover(monkeypatch, KaitenRolesResult(roles=roles))
    res = runner.invoke(app, ["roles"])
    assert res.exit_code == 0, res.stderr
    assert "Техподдержка" in res.output
    assert "Employee" not in res.output
    assert "(1 roles)" in res.output


def test_roles_all_shows_system_role(monkeypatch: pytest.MonkeyPatch) -> None:
    roles = [KaitenRole(id=-1, name="Employee"), KaitenRole(id=12058, name="Техподдержка")]
    _patch_roles_discover(monkeypatch, KaitenRolesResult(roles=roles))
    res = runner.invoke(app, ["roles", "--all", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(list[dict[str, Any]], json.loads(res.output))
    assert [r["id"] for r in payload] == [-1, 12058]


def test_roles_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_roles_discover(monkeypatch, KaitenRolesResult(roles=[], error="нет ключа"))
    res = runner.invoke(app, ["roles"])
    assert res.exit_code == 1
    assert "roles: kaiten error" in res.stderr


def test_time_ls_summary_requires_date_from(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["time", "ls"])
    assert res.exit_code == 2  # иначе — случайный веер на все карточки подряд
    assert "--date-from" in res.output


def test_time_ls_summary_fans_out_over_cards(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    logs = [
        time_log(log_id=1, card_id=100, minutes=60, for_date="2026-07-20"),
        time_log(log_id=2, card_id=200, minutes=30, for_date="2026-07-20"),
    ]
    fake = FakeKaitenClient(
        user=user_payload(),
        cards=[card_payload(card_id=100), card_payload(card_id=200)],
        time_logs=logs,
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-20", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert payload["total_minutes"] == 90
    assert payload["scanned_cards"] == 2
    assert {log["card_id"] for log in payload["logs"]} == {100, 200}


def test_time_ls_summary_includes_hinted_cards(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Карточка, где я не участник (list_cards её не вернёт), но время туда писал — подсказка.
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 300, role_id=12058)
    fake = FakeKaitenClient(
        user=user_payload(),
        cards=[],
        time_logs=[time_log(log_id=9, card_id=300, for_date="2026-07-20")],
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-20", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert [log["card_id"] for log in payload["logs"]] == [300]


def test_time_ls_summary_empty_reports_scanned(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), cards=[card_payload(card_id=100)])
    )
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-20"])
    assert res.exit_code == 0, res.stderr
    assert "просмотрено карточек: 1" in res.output


def test_close_dry_run_shows_timer_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--stop-timer", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert "таймер: остановить" in res.output
    assert not fake.timers_stopped
    assert not fake.move_calls


def test_close_without_flag_warns_and_keeps_timer(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Создавать запись времени побочным эффектом закрытия нельзя: забытый таймер
    # молча превратился бы в запись на десятки часов.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert "НЕ остановлен" in res.stderr
    assert not fake.timers_stopped


def test_close_stop_timer_logs_before_fields(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Порядок важен: отработанное время должно быть записано до полей/ответа/переноса,
    # любой из которых может упасть.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    order: list[str] = []
    fake = FakeKaitenClient(
        user=user_payload(),
        details=[card_detail(timer=timer_payload())],
        time_logs=[time_log(log_id=4471)],
    )
    real_stop = fake.stop_timer
    real_prop = fake.set_card_property

    def _stop(*a: object, **k: object) -> KaitenTimer:
        order.append("timer")
        return cast(Any, real_stop)(*a, **k)

    def _prop(*a: object, **k: object) -> None:
        order.append("field")
        cast(Any, real_prop)(*a, **k)

    monkeypatch.setattr(fake, "stop_timer", _stop)
    monkeypatch.setattr(fake, "set_card_property", _prop)
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--no-move", "--stop-timer", "--done", "сделано"])
    assert res.exit_code == 0, res.stderr
    assert order == ["timer", "field"]
    assert "таймер: 1 ч" in res.output


def test_close_stop_timer_without_running_timer_is_ok(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--no-move", "--stop-timer"])
    assert res.exit_code == 0, res.stderr  # оркестратору не из-за чего падать
    assert not fake.timers_stopped


def test_install_client_covers_every_command_module() -> None:
    # Забытый в `COMMAND_MODULES` модуль = тесты, молча ходящие в сеть.
    import pkgutil

    import mpu.commands.kiten as kiten_pkg

    with_client = {
        name
        for _, name, _ in pkgutil.iter_modules(kiten_pkg.__path__)
        if not name.startswith("_")
        and hasattr(__import__(f"mpu.commands.kiten.{name}", fromlist=[name]), "KaitenClient")
    }
    covered = {mod.__name__.rsplit(".", 1)[-1] for mod in COMMAND_MODULES}
    assert with_client <= covered, f"без подмены клиента: {with_client - covered}"


# --- CLI: остаточные ветки (таблицы, ошибки API, деградация) ------------------


def test_time_ls_summary_table_output(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    logs = [
        time_log(log_id=1, card_id=100, minutes=60, for_date="2026-07-20", comment="первое"),
        time_log(
            log_id=2, card_id=200, minutes=30, for_date="2026-07-19", user="Коллега", user_id=99
        ),
    ]
    fake = FakeKaitenClient(
        user=user_payload(),
        cards=[card_payload(card_id=100), card_payload(card_id=200)],
        time_logs=logs,
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-19", "--all"])
    assert res.exit_code == 0, res.stderr
    assert "Коллега" in res.output  # колонка ПОЛЬЗОВАТЕЛЬ появляется при --all
    assert "просмотрено карточек: 2" in res.output
    assert "итого: 1 ч 30 мин" in res.output


def test_time_ls_summary_survives_unreadable_card(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Недоступная карточка не должна ронять всю сводку.
    fake = FakeKaitenClient(
        user=user_payload(), cards=[card_payload(card_id=100)], fail={"list_time_logs"}
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-20"])
    assert res.exit_code == 0, res.stderr
    assert "просмотрено карточек: 0" in res.output


def test_time_ls_summary_survives_list_cards_failure(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Поиск карточек упал — сводка всё равно строится по локальным подсказкам.
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 300)
    fake = FakeKaitenClient(
        user=user_payload(),
        time_logs=[time_log(log_id=9, card_id=300, for_date="2026-07-20")],
        fail={"list_cards"},
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "ls", "--date-from", "2026-07-20", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert [log["card_id"] for log in payload["logs"]] == [300]


def test_time_ls_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), fail={"list_time_logs"}))
    res = runner.invoke(app, ["time", "ls", "100"])
    assert res.exit_code == 1
    assert "time ls: kaiten error" in res.stderr


def test_time_ls_role_filter(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    logs = [time_log(log_id=1, role_id=12058), time_log(log_id=2, role_id=12057)]
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=logs))
    res = runner.invoke(app, ["time", "ls", "100", "--role", "разработка", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert [log["id"] for log in payload["logs"]] == [2]


def test_time_edit_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "edit", "100", "7", "--time", "1h", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert not fake.logs_patched


def test_time_edit_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(), time_logs=[time_log(log_id=7)], fail={"update_time_log"}
        ),
    )
    res = runner.invoke(app, ["time", "edit", "100", "7", "--time", "1h"])
    assert res.exit_code == 1
    assert "time edit: kaiten error" in res.stderr


def test_time_rm_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(), time_logs=[time_log(log_id=7)], fail={"delete_time_log"}
        ),
    )
    res = runner.invoke(app, ["time", "rm", "100", "7"])
    assert res.exit_code == 1
    assert "time rm: kaiten error" in res.stderr


def test_time_rm_missing_log(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(
        monkeypatch, FakeKaitenClient(user=user_payload(), time_logs=[time_log(log_id=7)])
    )
    res = runner.invoke(app, ["time", "rm", "100", "999"])
    assert res.exit_code == 1
    assert "time ls 100" in res.stderr


def test_time_start_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(), details=[card_detail(timer=None)], fail={"start_timer"}
        ),
    )
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 1
    assert "time start: kaiten error" in res.stderr


def test_time_status_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), fail={"get_card"}))
    res = runner.invoke(app, ["time", "status", "100"])
    assert res.exit_code == 1
    assert "time status: kaiten error" in res.stderr


def test_time_status_json_without_hint(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["time", "status", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = cast(dict[str, Any], json.loads(res.output))
    assert payload == {"card_id": None, "timer": None}


def test_time_stop_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(), details=[card_detail(timer=timer_payload())], fail={"stop_timer"}
        ),
    )
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 1
    assert "time stop: kaiten error" in res.stderr


def test_time_stop_when_readback_finds_nothing(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Запись создана, но перечитать её не удалось — печатаем хотя бы её id, не падаем.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    fake = FakeKaitenClient(user=user_payload(), details=[card_detail(timer=timer_payload())])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "stop", "100"])
    assert res.exit_code == 0, res.stderr
    assert "запись 4471" in res.output


def test_time_discard_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(),
            details=[card_detail(timer=timer_payload())],
            fail={"discard_timer"},
        ),
    )
    res = runner.invoke(app, ["time", "discard", "100"])
    assert res.exit_code == 1
    assert "time discard: kaiten error" in res.stderr


def test_close_stop_timer_api_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    freeze_now(monkeypatch, datetime.datetime(2026, 7, 20, 10, 0, tzinfo=UTC))
    install_client(
        monkeypatch,
        FakeKaitenClient(
            user=user_payload(), details=[card_detail(timer=timer_payload())], fail={"stop_timer"}
        ),
    )
    res = runner.invoke(app, ["close", "100", "--no-move", "--stop-timer"])
    assert res.exit_code == 1
    assert "close: kaiten error (таймер)" in res.stderr


def test_time_start_ignores_unreadable_hinted_card(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    # Карточка из подсказки недоступна — это не повод блокировать старт.
    patch_roles_cache(monkeypatch, ROLES)
    install_env(monkeypatch, {})
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_time_hint(conn, 555, timer_id=901)

    class _PickyFake(FakeKaitenClient):
        def get_card(self, card_id: int) -> KaitenCardDetail:
            if card_id == 555:
                raise KaitenAPIError("GET", "/cards/555", 403, "no access")
            return super().get_card(card_id)

    fake = _PickyFake(user=user_payload(), details=[card_detail(card_id=100, timer=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["time", "start", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.timers_started
