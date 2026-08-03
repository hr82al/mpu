"""Тесты `mpu kiten checklist` — чек-листы карточки (интерактивные чекбоксы).

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import json

import pytest

from kiten_fakes import FakeKaitenClient, card_detail, checklist, install_client, runner
from mpu.commands.kiten import app, ordered_items, resolve_checklist_item
from mpu.lib.kaiten import KaitenChecklist, KaitenChecklistItem

# ── resolve_checklist_item (чистая функция) ─────────────────────────────────────

_CHECKLISTS = [
    checklist(
        checklist_id=500,
        name="Подзадачи",
        items=[(1, "Спека отличий", True), (2, "План реализации", False)],
    ),
    checklist(checklist_id=501, name="Ревью", items=[(3, "Ревью спеки", False)]),
]


def test_resolve_item_by_id() -> None:
    ref = resolve_checklist_item(_CHECKLISTS, "3")
    assert (ref.checklist.id, ref.item.text) == (501, "Ревью спеки")


def test_resolve_item_by_substring_casefold() -> None:
    ref = resolve_checklist_item(_CHECKLISTS, "план реал")
    assert (ref.checklist.id, ref.item.id) == (500, 2)


def test_resolve_item_not_found_lists_candidates() -> None:
    with pytest.raises(ValueError, match="не найден; есть: 1: Спека отличий"):
        resolve_checklist_item(_CHECKLISTS, "деплой")


def test_resolve_item_ambiguous_lists_matches() -> None:
    with pytest.raises(ValueError, match=r"неоднозначен, кандидаты: 1: .*; 2: .*; 3: Ревью спеки"):
        resolve_checklist_item(_CHECKLISTS, "е")


def test_resolve_item_no_items_at_all() -> None:
    with pytest.raises(ValueError, match=r"\(пунктов нет\)"):
        resolve_checklist_item([], "1")


def test_resolve_numeric_ref_falls_back_to_text() -> None:
    """Число, не совпавшее ни с одним id, ищется как подстрока текста — не ошибка."""
    lists = [checklist(items=[(7, "Шаг 42: сверка", False)])]
    assert resolve_checklist_item(lists, "42").item.id == 7


# ── ordered_items (чистая функция) ─────────────────────────────────────────────

# API отдаёт пункты в произвольном порядке — живьём отмеченный первый приезжал четвёртым.
_SHUFFLED = KaitenChecklist(
    id=500,
    name="Подзадачи",
    items=[
        KaitenChecklistItem(id=22, text="второй", sort_order=2.0),
        KaitenChecklistItem(id=33, text="третий", sort_order=2.5),
        KaitenChecklistItem(id=11, text="первый", checked=True, sort_order=1.0),
    ],
)


def test_ordered_items_sorts_by_sort_order() -> None:
    assert [i.id for i in ordered_items(_SHUFFLED.items)] == [11, 22, 33]


def test_ordered_items_without_sort_order_falls_back_to_id() -> None:
    items = [KaitenChecklistItem(id=9, text="b"), KaitenChecklistItem(id=4, text="a")]
    assert [i.id for i in ordered_items(items)] == [4, 9]


# ── ls ─────────────────────────────────────────────────────────────────────────


def test_checklist_ls_prints_items_in_card_order(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=[_SHUFFLED])])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "ls", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    assert [i["id"] for i in json.loads(res.output)[0]["items"]] == [11, 22, 33]


def test_checklist_ls_prints_items(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=_CHECKLISTS)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "ls", "100"])
    assert res.exit_code == 0, res.stderr
    assert "Подзадачи · 1/2 (checklist id 500)" in res.output
    # `[x]` доживает до вывода только с markup=False — иначе rich съедает его как тег
    assert "[x]" in res.output and "[ ]" in res.output
    assert "Спека отличий" in res.output


def test_checklist_ls_json(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=_CHECKLISTS)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "ls", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    payload = json.loads(res.output)
    assert payload[0]["name"] == "Подзадачи"
    assert payload[0]["items"][0] == {"id": 1, "checked": True, "text": "Спека отличий"}


def test_checklist_ls_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail()])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "ls", "100"])
    assert res.exit_code == 0, res.stderr
    assert "(чек-листов нет)" in res.output


def test_checklist_ls_api_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(fail={"get_card"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "ls", "100"])
    assert res.exit_code == 1
    assert "checklist ls: kaiten error" in res.stderr


# ── add ────────────────────────────────────────────────────────────────────────


def test_checklist_add_creates_and_fills(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail()])
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app, ["checklist", "add", "100", "--name", "Подзадачи", "-i", "Раз", "-i", "Два"]
    )
    assert res.exit_code == 0, res.stderr
    assert fake.checklists_added == [(100, "Подзадачи")]
    assert [(i["text"], i["sort_order"]) for i in fake.items_added] == [("Раз", 1.0), ("Два", 2.0)]
    assert "ok: чек-лист «Подзадачи» (создан, id 501), добавлено пунктов: 2" in res.output


def test_checklist_add_idempotent_by_name_and_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """Повторный запуск не плодит ни чек-лист, ни уже существующие пункты."""
    existing = checklist(checklist_id=500, name="Подзадачи", items=[(1, "Раз", False)])
    fake = FakeKaitenClient(details=[card_detail(checklists=[existing])])
    install_client(monkeypatch, fake)
    res = runner.invoke(
        app, ["checklist", "add", "100", "--name", "Подзадачи", "-i", "Раз", "-i", "Два"]
    )
    assert res.exit_code == 0, res.stderr
    assert fake.checklists_added == []
    assert [(i["checklist_id"], i["text"], i["sort_order"]) for i in fake.items_added] == [
        (500, "Два", 3.0)  # база — максимальный sort_order существующих пунктов (1.0) + номер
    ]
    assert "(существующий, id 500), добавлено пунктов: 1" in res.output


def test_checklist_add_without_items_only_creates(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail()])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "add", "100", "-n", "Пусто"])
    assert res.exit_code == 0, res.stderr
    assert fake.checklists_added == [(100, "Пусто")] and fake.items_added == []
    assert "добавлено пунктов: 0" in res.output


def test_checklist_add_api_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail()], fail={"add_checklist"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "add", "100", "-n", "Подзадачи"])
    assert res.exit_code == 1
    assert "checklist add: kaiten error" in res.stderr


# ── check / uncheck ────────────────────────────────────────────────────────────


def test_checklist_check_by_substring(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=_CHECKLISTS)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "check", "100", "План реализации"])
    assert res.exit_code == 0, res.stderr
    assert fake.items_checked == [(100, 500, 2, True)]
    assert "ok: [x] План реализации" in res.output


def test_checklist_uncheck_by_id(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=_CHECKLISTS)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "uncheck", "100", "1"])
    assert res.exit_code == 0, res.stderr
    assert fake.items_checked == [(100, 500, 1, False)]
    assert "ok: [ ] Спека отличий" in res.output


def test_checklist_check_unresolvable_item_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(checklists=_CHECKLISTS)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "check", "100", "деплой"])
    assert res.exit_code == 1
    assert "checklist check: пункт 'деплой' не найден" in res.stderr
    assert fake.items_checked == []


def test_checklist_check_api_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(
        details=[card_detail(checklists=_CHECKLISTS)], fail={"set_checklist_item_checked"}
    )
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["checklist", "check", "100", "1"])
    assert res.exit_code == 1
    assert "checklist check: kaiten error" in res.stderr
