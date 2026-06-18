"""Тесты `lib/pg` — проброс read-only опции в psycopg.connect."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from mpu.lib import pg, servers


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "pg_1='10.1.0.1'\nPG_PORT='5432'\nPG_DB_NAME='wb'\n"
        "PG_MY_USER_NAME='u'\nPG_MY_USER_PASSWORD='p'\n"
        "DEV_PG_USER='u'\nDEV_PG_PASSWORD='p'\n"
    )
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    servers.reset_cache()
    yield
    servers.reset_cache()


def _capture_connect(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_connect(**kw: Any) -> object:
        captured.update(kw)
        return object()

    monkeypatch.setattr(pg.psycopg, "connect", fake_connect)
    return captured


def test_connect_to_read_only_sets_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_to(1, read_only=True)
    assert captured["options"] == "-c default_transaction_read_only=on"


def test_connect_to_default_no_ro_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_to(1)
    # options=None передаётся всегда; psycopg.make_conninfo отбрасывает None-параметры.
    assert captured["options"] is None


def test_connect_dev_read_only_sets_options(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_connect(monkeypatch)
    pg.connect_dev(read_only=True)
    assert captured["options"] == "-c default_transaction_read_only=on"
