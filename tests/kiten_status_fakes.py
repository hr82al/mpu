"""Общие двойники и фабрики для тестов `mpu kiten status` (три файла: data/render/cmd).

Вынесено сюда по CLAUDE.md §8.8: общий фейк-клиент и фабрики карточек не копируются
в каждый тестовый файл. Модуль импортируется как обычный (не conftest-фикстура) — его
фабрики нужны и на уровне `parametrize`, где фикстуры недоступны.
"""

from __future__ import annotations

from typing import Any

import pytest

from mpu.commands.kiten import status as kiten_status
from mpu.commands.kiten._status_data import StatusRow
from mpu.lib import env, kaiten_cache
from mpu.lib.kaiten import KaitenAPIError
from mpu.lib.kaiten_models import KaitenActivity, KaitenCard, KaitenTimeLogEntry, KaitenUser

BASE = "https://btlz.kaiten.ru"
ME_ID = 518617


def card(
    card_id: int = 100,
    *,
    title: str = "карточка",
    state: int | None = 2,
    condition: int | None = 1,
    archived: bool = False,
    updated: str = "2026-07-23T10:00:00.000Z",
    column_title: str | None = "В работе",
    column_id: int | None = 500,
    lane_title: str | None = "Веб-разработка",
    board_id: int | None = 900,
    lane_id: int | None = 800,
) -> KaitenCard:
    """Карточка в форме, в какой её отдаёт `/cards` (с уже плоскими названиями места)."""
    return KaitenCard(
        id=card_id,
        title=title,
        state=state,
        condition=condition,
        archived=archived,
        updated=updated,
        column_title=column_title,
        column_id=column_id,
        lane_title=lane_title,
        board_id=board_id,
        lane_id=lane_id,
        url=f"{BASE}/{card_id}",
    )


def row(source: KaitenCard | None = None, *, stage: str = "В работе", **kw: Any) -> StatusRow:
    return StatusRow(card=source or card(), stage=stage, **kw)


def time_log(
    source: KaitenCard, minutes: int = 25, for_date: str = "2026-07-22", role: str = "Код-ревью"
) -> KaitenTimeLogEntry:
    """Запись учёта времени с вложенной карточкой — как в окне `/users/{id}/time-logs`."""
    return KaitenTimeLogEntry(
        id=source.id,
        card_id=source.id,
        time_spent=minutes,
        for_date=for_date,
        role_name=role,
        card=source,
    )


class FakeClient:
    """Дак-тайп KaitenClient: только методы, которые дёргает `status`."""

    def __init__(
        self,
        *,
        cards: list[KaitenCard] | None = None,
        responsible: list[KaitenCard] | None = None,
        logs: list[KaitenTimeLogEntry] | None = None,
        activities: list[KaitenActivity] | None = None,
        error: KaitenAPIError | None = None,
    ) -> None:
        self.base_url = BASE
        self._cards = cards or []
        self._responsible = responsible or []
        self._logs = logs or []
        self._activities = activities or []
        self._error = error
        self.time_window: tuple[str, str] | None = None
        self.max_pages: int | None = None

    def current_user(self) -> KaitenUser:
        if self._error is not None:
            raise self._error
        return KaitenUser(id=ME_ID, full_name="Я", username="me", email="me@example.com")

    def list_cards(self, **kw: Any) -> list[KaitenCard]:
        return self._responsible if kw.get("responsible_id") is not None else self._cards

    def list_user_time_logs(
        self, _user_id: int, *, from_iso: str, to_iso: str
    ) -> list[KaitenTimeLogEntry]:
        self.time_window = (from_iso, to_iso)
        return self._logs

    def list_my_activities(self, **kw: Any) -> list[KaitenActivity]:
        self.max_pages = kw.get("max_pages")
        return self._activities


def install_env(monkeypatch: pytest.MonkeyPatch, values: dict[str, str]) -> None:
    """Подменить `env.get` словарём (изоляция от реального ~/.config/mpu/.env)."""

    def _get(name: str, default: str | None = None) -> str | None:
        return values.get(name, default)

    monkeypatch.setattr(env, "get", _get)


def install_directory(
    monkeypatch: pytest.MonkeyPatch,
    *,
    columns: list[tuple[int, str]] | None = None,
    boards: list[tuple[int, str]] | None = None,
) -> None:
    """Подменить кэш справочника (изоляция от реального ~/.config/mpu/mpu.db)."""

    def _columns(board_id: int | None = None) -> list[tuple[int, str]]:
        _ = board_id
        return list(columns or [])

    def _boards(space_id: int | None = None) -> list[tuple[int, str]]:
        _ = space_id
        return list(boards or [])

    monkeypatch.setattr(kaiten_cache, "cached_columns", _columns)
    monkeypatch.setattr(kaiten_cache, "cached_boards", _boards)


def install_client(monkeypatch: pytest.MonkeyPatch, fake: FakeClient) -> None:
    """Подменить `KaitenClient.from_env()` в модуле команды + изолировать env и кэш."""

    class _Stub:
        @staticmethod
        def from_env() -> FakeClient:
            return fake

    monkeypatch.setattr(kiten_status, "KaitenClient", _Stub)
    install_env(monkeypatch, {})
    install_directory(monkeypatch)
