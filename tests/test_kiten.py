"""Тесты `mpu kiten` — только чистые функции (без сети и без моков HTTP).

I/O-клиент `KaitenClient` (_request/current_user/list_cards) тестами не покрыт —
прецедент miro/slapi. Здесь: сборка query, парсинг карточки, маппинг state,
URL и precedence фильтров (CLI > env > дефолт).
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from kiten_fakes import FakeKaitenClient, install_client, runner, user_payload
from mpu.commands.kiten import (
    app,
    coalesce,
)
from mpu.lib.kaiten import (
    card_url,
    parse_card,
    state_label,
)

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


# ── coalesce ───────────────────────────────────────────────────────────────────


def test_coalesce_first_non_none() -> None:
    assert coalesce(None, None, 3) == 3
    assert coalesce(1, 2) == 1
    assert coalesce(None, None) is None


# ── whoami ──────────────────────────────────────────────────────────────────────


def test_whoami_text(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["whoami"])
    assert res.exit_code == 0, res.stderr
    assert "id:    42" in res.output
    assert "login: me" in res.output
    assert "email: me@x" in res.output


def test_whoami_json(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload()))
    res = runner.invoke(app, ["whoami", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: dict[str, Any] = json.loads(res.output)
    assert payload == {"id": 42, "full_name": "Me", "username": "me", "email": "me@x"}


def test_whoami_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient(user=user_payload(), fail={"current_user"}))
    res = runner.invoke(app, ["whoami"])
    assert res.exit_code == 1
    assert "kaiten error" in res.stderr
