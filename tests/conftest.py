"""Shared pytest fixtures and helpers."""

from collections.abc import Callable
from pathlib import Path

import pytest

from mpu.lib import store

_LOG_DEFAULTS = {
    "MPU_LOG_ENABLED": "1",
    "MPU_LOG_MAX_OUTPUT_BYTES": "0",  # 0 = без обрезки: тесты сверяют вывод целиком
    "MPU_LOG_MAX_BYTES": "52428800",
    "MPU_LOG_KEEP": "5",
}


@pytest.fixture(autouse=True)
def isolate_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Лог тестов — в tmp, режим детерминированный.

    Пинятся ВСЕ переменные лога, а не только путь: `env.load()` вызывает `load_dotenv`
    с `override=False`, поэтому отсутствующую переменную подставил бы личный
    `~/.config/mpu/.env` разработчика. `monkeypatch.delenv` по той же причине не годится.
    """
    monkeypatch.setenv("MPU_LOG_FILE", str(tmp_path / "mpu-test.log"))
    for name, value in _LOG_DEFAULTS.items():
        monkeypatch.setenv(name, value)


@pytest.fixture
def bootstrap_db() -> Callable[[Path | str], None]:
    """Helper для тестов: применить `store.bootstrap()` к указанному пути.

    `open_store()` после рефакторинга больше не делает DDL — это делает явный
    `bootstrap()` (вызывается в продакшене из `mpu init`). В тестах быстрее всего
    дёрнуть этот helper в setup-блоке вместо `with store.store() as c: bootstrap(c)`.
    """

    def _do(path: Path | str) -> None:
        conn = store.open_store(path)
        try:
            store.bootstrap(conn)
        finally:
            conn.close()

    return _do
