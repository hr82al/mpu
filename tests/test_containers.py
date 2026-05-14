"""Тесты `mpu.lib.containers` — резолв контейнера по точному имени из SQLite-кэша."""

from collections.abc import Callable
from pathlib import Path

import pytest

from mpu.lib import containers, store


def _seed(
    bootstrap_db: Callable[[Path | str], None],
    rows: list[tuple[str, int, str | None, str, str]],
) -> None:
    """rows: list of (portainer_url, endpoint_id, endpoint_name, container_id, container_name)."""
    bootstrap_db(store.DB_PATH)
    with store.store() as conn:
        for row in rows:
            url, eid, ep_name, cid, cname = row
            conn.execute(
                "INSERT INTO portainer_containers "
                "(portainer_url, endpoint_id, endpoint_name, container_id, "
                " container_name, server_number, discovered_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (url, eid, ep_name, cid, cname, None, 100),
            )
        conn.commit()


@pytest.fixture(autouse=True)
def _isolate_db(  # pyright: ignore[reportUnusedFunction]
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")


def test_find_returns_empty_when_no_db() -> None:
    """Нет файла БД — graceful empty list, не падение."""
    assert containers.find_container_targets("mp-dt-cli") == []


def test_find_returns_empty_when_not_found(
    bootstrap_db: Callable[[Path | str], None],
) -> None:
    bootstrap_db(store.DB_PATH)
    assert containers.find_container_targets("nope") == []


def test_resolve_unique(bootstrap_db: Callable[[Path | str], None]) -> None:
    _seed(
        bootstrap_db,
        [("https://192.168.150.12:9443", 12, "mp-dt", "c1", "mp-dt-cli")],
    )
    assert containers.resolve_container_target("mp-dt-cli") == (
        "https://192.168.150.12:9443",
        12,
    )


def test_resolve_not_found_raises(bootstrap_db: Callable[[Path | str], None]) -> None:
    bootstrap_db(store.DB_PATH)
    with pytest.raises(containers.ContainerResolveError) as excinfo:
        containers.resolve_container_target("mp-dt-cli")
    assert "not found" in str(excinfo.value)
    assert excinfo.value.candidates == []


def test_resolve_ambiguous_raises_with_candidates(
    bootstrap_db: Callable[[Path | str], None],
) -> None:
    _seed(
        bootstrap_db,
        [
            ("https://p1:9443", 12, "mp-dt", "c1", "cli"),
            ("https://p1:9443", 14, "wb-positions-parser", "c2", "cli"),
            ("https://p1:9443", 15, "wb-clusters-parser", "c3", "cli"),
        ],
    )
    with pytest.raises(containers.ContainerResolveError) as excinfo:
        containers.resolve_container_target("cli")
    assert "ambiguous" in str(excinfo.value)
    assert len(excinfo.value.candidates) == 3
    endpoint_names = {c["endpoint_name"] for c in excinfo.value.candidates}
    assert endpoint_names == {"mp-dt", "wb-positions-parser", "wb-clusters-parser"}


def test_format_candidates_contains_endpoint_and_url() -> None:
    out = containers.format_container_candidates(
        [
            {
                "portainer_url": "https://p:9443",
                "endpoint_id": 12,
                "endpoint_name": "mp-dt",
                "container_name": "cli",
            }
        ]
    )
    assert "endpoint=mp-dt" in out
    assert "id=12" in out
    assert "url=https://p:9443" in out
