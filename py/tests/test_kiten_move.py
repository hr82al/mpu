"""Тесты `mpu kiten move|ready|review|close` — перемещение карточки и журнал.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
import typer

from kiten_fakes import (
    BOARD_COLS,
    FakeColumnsClient,
    FakeKaitenClient,
    card_detail,
    card_links,
    install_client,
    install_env,
    patch_columns_cache,
    recorded_moves,
    runner,
)
from mpu.commands.kiten import (
    _expand_all_to_owner,  # pyright: ignore[reportPrivateUsage]
    _left_neighbor_column,  # pyright: ignore[reportPrivateUsage]
    app,
    expand_all_mention,
    plan_field_actions,
)
from mpu.lib import kaiten_cache
from mpu.lib.kaiten import (
    KaitenCardDetail,
    KaitenClient,
    KaitenColumn,
    parse_card_detail,
)

# ── _left_neighbor_column: соседняя слева колонка для релог-bump ─────────────────


def _board_columns() -> list[KaitenColumn]:
    return [
        KaitenColumn(id=10, board_id=1, title="Очередь", sort_order=1.0),
        KaitenColumn(id=20, board_id=1, title="Разработка", sort_order=2.0),
        KaitenColumn(id=30, board_id=1, title="Готово", sort_order=3.0),
    ]


def _fake_client(columns: list[KaitenColumn]) -> KaitenClient:
    # cast: фейк покрывает только list_columns, единственное, что нужно _left_neighbor_column.
    return cast("KaitenClient", FakeColumnsClient(columns))


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


# Все модули команд `kiten`, которым нужна подмена клиента. Забытый здесь модуль означал бы
# тесты, молча ходящие в сеть, — на состав есть отдельный тест `test_install_client_covers_*`.


def _ordered_columns() -> list[KaitenColumn]:
    return [
        KaitenColumn(id=10, board_id=1, title="Очередь", sort_order=1.0),
        KaitenColumn(id=20, board_id=1, title="Разработка", sort_order=2.0),
        KaitenColumn(id=30, board_id=1, title="Готово", sort_order=3.0),
    ]


# ── move ────────────────────────────────────────────────────────────────────────


def test_move_no_axis_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["move", "100"])
    assert res.exit_code == 2
    assert "хотя бы одно" in res.stderr


def test_move_column_numeric(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 0, res.stderr
    assert "→ Board · Готово · Lane" in res.output
    assert fake.move_calls == [{"card_id": 100, "lane_id": None, "column_id": 30, "board_id": None}]
    moves = recorded_moves()
    assert len(moves) == 1
    assert moves[0].to_column == "Готово"
    assert moves[0].from_column == "Очередь"


def test_move_column_name_resolved(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "Готово"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 30


def test_move_relog_when_already_in_column(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = card_detail(column_id=30, column_title="Готово")
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after], columns=_ordered_columns())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 0, res.stderr
    assert "(релог)" in res.output
    assert [c["column_id"] for c in fake.move_calls] == [20, 30]  # сосед слева → обратно


def test_move_to_board(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=10, column_title="Очередь", board_title="Other")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--board", "2"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["board_id"] == 2


def test_move_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(details=[card_detail()], fail={"get_card"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["move", "100", "--column", "30"])
    assert res.exit_code == 1
    assert "move: kaiten error" in res.stderr
    assert recorded_moves() == []


# ── ready / review (через _move_to_target_column) ───────────────────────────────


def test_ready_default_target(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 30
    moves = recorded_moves()
    assert moves[0].to_column == "Готово"


def test_ready_env_column_override(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {"KITEN_READY_COLUMN": "Разработка"})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=20, column_title="Разработка")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 20


def test_ready_column_flag_numeric(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=20, column_title="Разработка")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100", "--column", "20"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 20


def test_ready_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    fake = FakeKaitenClient(details=[card_detail(column_id=10, column_title="Очередь")])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert "dry-run:" in res.output
    assert "PATCH не отправлен" in res.output
    assert fake.move_calls == []
    assert recorded_moves() == []


def test_ready_relog(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=30, column_title="Готово")
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, after], columns=_ordered_columns())
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 0, res.stderr
    assert "(релог)" in res.output
    assert [c["column_id"] for c in fake.move_calls] == [20, 30]


def test_ready_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail()], fail={"get_card"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["ready", "100"])
    assert res.exit_code == 1
    assert "kaiten error" in res.stderr


def test_review_default_target(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, [(10, "Очередь"), (40, "Код-ревью")])
    before = card_detail(column_id=10, column_title="Очередь")
    after = card_detail(column_id=40, column_title="Код-ревью")
    fake = FakeKaitenClient(details=[before, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["review", "100"])
    assert res.exit_code == 0, res.stderr
    assert fake.move_calls[0]["column_id"] == 40
    assert recorded_moves()[0].to_column == "Код-ревью"


# ── close ───────────────────────────────────────────────────────────────────────


def test_close_dry_run(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(owner_username="ownerlogin", properties={})
    fake = FakeKaitenClient(details=[before, before])
    install_client(monkeypatch, fake)
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
    assert recorded_moves() == []


def test_close_dry_run_no_move(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail(properties={})])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move", "--dry-run"])
    assert res.exit_code == 0, res.stderr
    assert "перенос: пропущен (--no-move)" in res.output


def test_close_fills_fields_reply_and_moves(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=10, column_title="Очередь", properties={})
    before2 = card_detail(column_id=10, column_title="Очередь", properties={})
    after = card_detail(column_id=30, column_title="Готово", properties={})
    fake = FakeKaitenClient(details=[before, before2, after])
    install_client(monkeypatch, fake)
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
    assert recorded_moves()[0].to_column == "Готово"
    # три записи лога полей.
    assert {link.field for link in card_links()} == {"hypothesis", "done", "result"}


def test_close_skips_filled_field(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    patch_columns_cache(monkeypatch, BOARD_COLS)
    before = card_detail(column_id=10, properties={"id_291984": "уже есть"})
    before2 = card_detail(column_id=10, properties={"id_291984": "уже есть"})
    after = card_detail(column_id=30, column_title="Готово")
    fake = FakeKaitenClient(details=[before, before2, after])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "new"])
    assert res.exit_code == 0, res.stderr
    assert "пропущены (заполнены) [hypothesis]" in res.output
    assert fake.props_set == []  # ничего не записали (поле уже заполнено)


def test_close_no_move(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail(properties={})])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert fake.props_set == [(100, "id_291984", "h")]
    assert recorded_moves() == []  # перенос пропущен


def test_close_reply_file(monkeypatch: pytest.MonkeyPatch, db_path: Path, tmp_path: Path) -> None:
    install_env(monkeypatch, {})
    reply = tmp_path / "reply.md"
    reply.write_text("ответ из файла", encoding="utf-8")
    fake = FakeKaitenClient(details=[card_detail(properties={})])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply-file", str(reply), "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert fake.added_comments[0]["text"] == "ответ из файла"


def test_close_reply_and_reply_file_exclusive(
    monkeypatch: pytest.MonkeyPatch, db_path: Path
) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(details=[card_detail()]))
    res = runner.invoke(app, ["close", "100", "--reply", "a", "--reply-file", "-"])
    assert res.exit_code == 2
    assert "взаимоисключающи" in res.stderr


def test_close_empty_reply_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(details=[card_detail()]))
    res = runner.invoke(app, ["close", "100", "--reply", "   "])
    assert res.exit_code == 2
    assert "пустой текст ответа" in res.stderr


def test_close_reply_all_no_owner_warns(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail(owner_username=None, properties={})])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply", "@all привет", "--no-move"])
    assert res.exit_code == 0, res.stderr
    assert "нет владельца" in res.stderr


def test_close_error_before_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail()], fail={"get_card"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h"])
    assert res.exit_code == 1
    assert "close: kaiten error" in res.stderr


def test_close_error_in_fields_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail(properties={})], fail={"set_card_property"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--hypothesis", "h", "--no-move"])
    assert res.exit_code == 1
    assert "kaiten error (поля)" in res.stderr


def test_close_error_in_reply_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_env(monkeypatch, {})
    fake = FakeKaitenClient(details=[card_detail(properties={})], fail={"add_comment"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["close", "100", "--reply", "текст", "--no-move"])
    assert res.exit_code == 1
    assert "kaiten error (ответ)" in res.stderr


# ── resolve-ошибки осей перемещения → BadParameter (exit 2) ──────────────────────


def test_move_bad_column_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    patch_columns_cache(monkeypatch, [])  # пустой кэш → подстрока не резолвится
    install_client(monkeypatch, FakeKaitenClient(details=[card_detail()]))
    res = runner.invoke(app, ["move", "100", "--column", "Неизвестная"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr


def test_move_bad_board_exits_2(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    def _no_boards(space_id: int | None = None) -> list[tuple[int, str]]:
        _ = space_id
        return []

    monkeypatch.setattr(kaiten_cache, "cached_boards", _no_boards)
    install_client(monkeypatch, FakeKaitenClient(details=[card_detail()]))
    res = runner.invoke(app, ["move", "100", "--board", "Неизвестная"])
    assert res.exit_code == 2
    assert "не найден" in res.stderr
