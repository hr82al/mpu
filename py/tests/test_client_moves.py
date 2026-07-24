"""Тесты `mpu.lib.client_moves` (таблица client_moves в SQLite)."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from mpu.lib import client_moves, store


@pytest.fixture
def db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bootstrap_db: Callable[[Path | str], None],
) -> Iterator[Path]:
    """Изолированная БД с применённой схемой; `store.DB_PATH` указывает на неё."""
    path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", path)
    bootstrap_db(path)
    yield path


def test_record_then_last(db: Path) -> None:
    _ = db
    client_moves.record_move(1589, "sl-13", "sl-1", now=1000)
    assert client_moves.last_move(1589) == {
        "client_id": 1589,
        "source": "sl-13",
        "target": "sl-1",
        "moved_at": 1000,
    }


def test_last_move_missing_returns_none(db: Path) -> None:
    _ = db
    assert client_moves.last_move(999) is None


def test_record_move_upsert_overwrites(db: Path) -> None:
    _ = db
    client_moves.record_move(1589, "sl-13", "sl-1", now=1000)
    client_moves.record_move(1589, "sl-1", "sl-5", now=2000)
    assert client_moves.last_move(1589) == {
        "client_id": 1589,
        "source": "sl-1",
        "target": "sl-5",
        "moved_at": 2000,
    }


def test_list_moves_orders_desc(db: Path) -> None:
    _ = db
    client_moves.record_move(1, "sl-2", "sl-1", now=1000)
    client_moves.record_move(2, "sl-3", "sl-1", now=3000)
    client_moves.record_move(3, "sl-4", "sl-1", now=2000)
    assert [m["client_id"] for m in client_moves.list_moves()] == [2, 3, 1]


def test_list_moves_empty(db: Path) -> None:
    _ = db
    assert client_moves.list_moves() == []


def test_clear_move(db: Path) -> None:
    _ = db
    client_moves.record_move(1589, "sl-13", "sl-1", now=1000)
    client_moves.clear_move(1589)
    assert client_moves.last_move(1589) is None


def test_tolerates_missing_table(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Без `mpu init` (таблицы нет): операции не падают, чтения пустые."""
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "empty.db")
    client_moves.record_move(1, "sl-2", "sl-1", now=1000)  # не бросает
    client_moves.clear_move(1)  # не бросает
    assert client_moves.last_move(1) is None
    assert client_moves.list_moves() == []
