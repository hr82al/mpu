"""Тесты `lib/kaiten_links` — SQLite-лог привязок карточек к кастомным полям (без сети)."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from mpu.lib import kaiten_links, store


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    with store.store(tmp_path / "mpu.db") as c:
        store.bootstrap(c)
        yield c


def test_property_key() -> None:
    assert kaiten_links.property_key("mr") == "id_398965"
    assert kaiten_links.property_key("hypothesis") == "id_291984"
    assert kaiten_links.property_key("done") == "id_291985"
    assert kaiten_links.property_key("result") == "id_291990"


def test_record_returns_row_and_lists_newest_first(conn: sqlite3.Connection) -> None:
    a = kaiten_links.record_link(conn, 100, "mr", "url-a", now=1000)
    b = kaiten_links.record_link(conn, 100, "mr", "url-b", now=2000)
    assert a.id != b.id
    links = kaiten_links.list_links(conn, card_id=100, field="mr")
    assert [link.value for link in links] == ["url-b", "url-a"]


def test_latest_value_picks_most_recent(conn: sqlite3.Connection) -> None:
    kaiten_links.record_link(conn, 1, "mr", "first", now=10)
    kaiten_links.record_link(conn, 1, "mr", "second", now=20)
    assert kaiten_links.latest_value(conn, 1, "mr") == "second"


def test_latest_value_none_when_empty(conn: sqlite3.Connection) -> None:
    assert kaiten_links.latest_value(conn, 999, "mr") is None


def test_filter_by_card_and_field(conn: sqlite3.Connection) -> None:
    kaiten_links.record_link(conn, 1, "mr", "m1")
    kaiten_links.record_link(conn, 2, "mr", "m2")
    kaiten_links.record_link(conn, 1, "done", "d1")
    assert {link.value for link in kaiten_links.list_links(conn, card_id=1)} == {"m1", "d1"}
    assert {link.value for link in kaiten_links.list_links(conn, field="mr")} == {"m1", "m2"}


def test_update_link(conn: sqlite3.Connection) -> None:
    a = kaiten_links.record_link(conn, 1, "mr", "old")
    updated = kaiten_links.update_link(conn, a.id, "new")
    assert updated is not None
    assert updated.value == "new"
    assert kaiten_links.update_link(conn, 99999, "x") is None


def test_delete_link_resyncs_latest(conn: sqlite3.Connection) -> None:
    a = kaiten_links.record_link(conn, 1, "mr", "first", now=10)
    b = kaiten_links.record_link(conn, 1, "mr", "second", now=20)
    deleted = kaiten_links.delete_link(conn, b.id)
    assert deleted is not None
    assert deleted.value == "second"
    # последняя удалена → latest откатывается на предыдущую
    assert kaiten_links.latest_value(conn, 1, "mr") == "first"
    # удалить оставшуюся → пусто
    kaiten_links.delete_link(conn, a.id)
    assert kaiten_links.latest_value(conn, 1, "mr") is None
    assert kaiten_links.delete_link(conn, 99999) is None
