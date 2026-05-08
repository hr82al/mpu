"""Shared pytest fixtures and helpers."""

from collections.abc import Callable
from pathlib import Path

import pytest

from mpu.lib import store


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
