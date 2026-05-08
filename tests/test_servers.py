"""Тесты резолвера server-name → number → IP."""

from collections.abc import Iterator
from pathlib import Path

import pytest

from mpu.lib import servers, store


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "# comment\n"
        "\n"
        "pg_0='192.168.150.30'\n"
        'pg_1="192.168.150.31"\n'
        "pg_12=192.168.150.52\n"
        "sl_0='192.168.150.90'\n"
        "sl_1='192.168.150.91'\n"
        "PG_PORT=5432\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    yield p
    servers.reset_cache()


def test_server_number_parsing() -> None:
    assert servers.server_number("sl-0") == 0
    assert servers.server_number("sl-1") == 1
    assert servers.server_number("sl-12") == 12
    assert servers.server_number("wb-1") is None
    assert servers.server_number("") is None
    assert servers.server_number(None) is None
    assert servers.server_number("sl-1a") is None


def test_ip_lookup(env_file: Path) -> None:
    assert servers.sl_ip(0) == "192.168.150.90"
    assert servers.sl_ip(1) == "192.168.150.91"
    assert servers.sl_ip(99) is None
    assert servers.pg_ip(0) == "192.168.150.30"
    assert servers.pg_ip(1) == "192.168.150.31"
    assert servers.pg_ip(12) == "192.168.150.52"


def test_env_value(env_file: Path) -> None:
    assert servers.env_value("PG_PORT") == "5432"
    assert servers.env_value("MISSING") is None


def test_missing_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(servers, "ENV_PATH", tmp_path / "nonexistent.env")
    servers.reset_cache()
    assert servers.sl_ip(0) is None
    assert servers.pg_ip(0) is None
    servers.reset_cache()
