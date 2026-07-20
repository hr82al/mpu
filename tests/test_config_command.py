"""Тесты CLI `mpu config` (mpu.commands.config).

Мокаем `store.DB_PATH` → tmp sqlite и изолируемся от реального окружения
(`env._loaded`), потому что часть ключей перекрывается env-переменными
`MPU_<KEY>` — это часть проверяемого контракта.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import config as config_cmd
from mpu.lib import env, store

runner = CliRunner()


@pytest.fixture
def db(
    tmp_path: Path,
    bootstrap_db: Callable[[Path | str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Path]:
    monkeypatch.setattr(env, "_loaded", True)
    for key in config_cmd.KEYS:
        monkeypatch.delenv(config_cmd.env_var_for(key.name), raising=False)
    path = tmp_path / "mpu.db"
    bootstrap_db(path)
    monkeypatch.setattr(store, "DB_PATH", path)
    yield path


def _stored_value(db_path: Path, key: str) -> str | None:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


# ────────────────────────────────────────────────────────────────────────────
# set / get / unset
# ────────────────────────────────────────────────────────────────────────────


def test_set_then_get_roundtrip(db: Path) -> None:
    """Проверяет: записанное значение читается обратно и лежит в таблице config."""
    written = runner.invoke(config_cmd.app, ["sheet.default", "1AbCdef"])
    assert written.exit_code == 0
    assert written.stdout.strip() == "sheet.default = 1AbCdef"
    assert _stored_value(db, "sheet.default") == "1AbCdef"

    read = runner.invoke(config_cmd.app, ["sheet.default"])
    assert read.stdout == "1AbCdef\n"


def test_set_is_idempotent_upsert(db: Path) -> None:
    """Проверяет: повторная запись перезаписывает, а не плодит строки."""
    runner.invoke(config_cmd.app, ["xlsx.default", "/one.xlsx"])
    runner.invoke(config_cmd.app, ["xlsx.default", "/two.xlsx"])
    assert _stored_value(db, "xlsx.default") == "/two.xlsx"
    assert runner.invoke(config_cmd.app, ["xlsx.default"]).stdout == "/two.xlsx\n"


def test_get_unset_key_prints_nothing(db: Path) -> None:
    """Проверяет: незаданный строковый ключ — пустой stdout (pipe-friendly), код 0."""
    result = runner.invoke(config_cmd.app, ["sheet.default"])
    assert result.exit_code == 0
    assert result.stdout == ""


def test_get_returns_module_default_for_int_key(db: Path) -> None:
    """Проверяет: незаданный ключ кэша отдаёт дефолт модуля-потребителя."""
    result = runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl"])
    assert result.stdout.strip() == "7200"


def test_unset_resets_to_default(db: Path) -> None:
    """Проверяет: --unset удаляет запись и сообщает дефолт."""
    runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl", "60"])
    result = runner.invoke(config_cmd.app, ["--unset", "sheet.cache.tab_ttl"])
    assert "сброшен к дефолту: 7200" in result.stdout
    assert _stored_value(db, "sheet.cache.tab_ttl") is None


def test_unset_without_key_is_rejected(db: Path) -> None:
    """Проверяет: --unset без ключа → код 2, а не тихий no-op."""
    result = runner.invoke(config_cmd.app, ["--unset"])
    assert result.exit_code == 2
    assert "требует имя ключа" in result.output


def test_unset_of_never_set_key_is_idempotent(db: Path) -> None:
    """Проверяет: сброс незаданного ключа — не ошибка."""
    assert runner.invoke(config_cmd.app, ["--unset", "xlsx.default"]).exit_code == 0


# ────────────────────────────────────────────────────────────────────────────
# Валидация
# ────────────────────────────────────────────────────────────────────────────


def test_unknown_key_lists_valid_ones(db: Path) -> None:
    """Проверяет: неизвестный ключ → код 2 и перечень допустимых."""
    result = runner.invoke(config_cmd.app, ["nosuch.key"])
    assert result.exit_code == 2
    assert "unknown config key" in result.output
    assert "sheet.default" in result.output


def test_int_key_rejects_non_numeric(db: Path) -> None:
    """Проверяет: в числовой ключ нельзя записать строку — иначе читатель молча взял бы дефолт."""
    result = runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl", "много"])
    assert result.exit_code == 2
    assert "ожидает целое число" in result.output
    assert _stored_value(db, "sheet.cache.tab_ttl") is None


# ────────────────────────────────────────────────────────────────────────────
# Список и env-приоритет
# ────────────────────────────────────────────────────────────────────────────


def test_list_shows_every_key_with_source(db: Path) -> None:
    """Проверяет: без аргументов печатаются все ключи, незаданные — с пометкой источника."""
    runner.invoke(config_cmd.app, ["sheet.default", "1AbC"])
    result = runner.invoke(config_cmd.app, [])
    assert "sheet.default" in result.stdout
    assert "1AbC" in result.stdout
    assert "(unset)" in result.stdout  # xlsx.default не задан
    assert "7200  (default)" in result.stdout


def test_list_json_is_structured(db: Path) -> None:
    """Проверяет: --json отдаёт ключ, значение, источник, дефолт и описание."""
    payload = json.loads(runner.invoke(config_cmd.app, ["--json"]).stdout)
    assert {item["key"] for item in payload} == set(config_cmd.KEYS_BY_NAME)
    by_key = {item["key"]: item for item in payload}
    assert by_key["sheet.cache.tab_ttl"]["source"] == "default"
    assert by_key["sheet.cache.tab_ttl"]["value"] == "7200"


def test_env_overrides_stored_value(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Проверяет: env MPU_<KEY> перекрывает таблицу — источник помечается как env."""
    runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl", "60"])
    monkeypatch.setenv("MPU_SHEET_CACHE_TAB_TTL", "999")
    result = runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl", "--json"])
    payload = json.loads(result.stdout)
    assert payload["value"] == "999"
    assert payload["source"] == "env"


def test_set_warns_when_env_shadows_the_key(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Проверяет: запись под активной env-переменной предупреждает, что значение не подействует."""
    monkeypatch.setenv("MPU_SHEET_CACHE_TAB_TTL", "999")
    result = runner.invoke(config_cmd.app, ["sheet.cache.tab_ttl", "60"])
    assert result.exit_code == 0
    assert "перекрывает это значение" in result.output


# ────────────────────────────────────────────────────────────────────────────
# Интеграция с потребителями
# ────────────────────────────────────────────────────────────────────────────


def test_written_key_is_picked_up_by_xlsx_resolver(db: Path, tmp_path: Path) -> None:
    """Проверяет: записанный xlsx.default реально резолвится `mpu xlsx` (не только хранится)."""
    from mpu.lib.xlsx_resolver import resolve_path

    runner.invoke(config_cmd.app, ["xlsx.default", "/data/report.xlsx"])
    conn = store.open_store(db)
    try:
        resolved = resolve_path(conn, None)
    finally:
        conn.close()
    assert resolved.path == Path("/data/report.xlsx")
    assert resolved.source == "config"
