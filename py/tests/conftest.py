"""Shared pytest fixtures and helpers."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from mpu.lib import servers, store

# Фикстуры kiten-пакета (общий клиент-фейк и обвязка) — отдельным модулем,
# иначе каждый из его тест-файлов копировал бы FakeKaitenClient заново.
pytest_plugins = ["kiten_fakes"]

_LOG_DEFAULTS = {
    "MPU_LOG_ENABLED": "1",
    "MPU_LOG_MAX_OUTPUT_BYTES": "0",  # 0 = без обрезки: тесты сверяют вывод целиком
    "MPU_LOG_MAX_BYTES": "52428800",
    "MPU_LOG_KEEP": "5",
}


class ContainerRunRecorder:
    """Двойник `pssh_run_container`: пишет вызовы, возвращает заданный код.

    Сигнатура `__call__` — точная копия продакшн-функции и в этом смысле сама является
    проверкой: если вызывающий код начнёт передавать аргументы иначе, упадут все тесты,
    а не тот один, где двойник поправили.
    """

    def __init__(self, rc: int = 0) -> None:
        self.calls: list[dict[str, object]] = []
        self.rc = rc

    def __call__(self, *, container: str, cmd: list[str], stdin: bytes = b"") -> int:
        self.calls.append({"container": container, "cmd": list(cmd), "stdin": stdin})
        return self.rc

    @property
    def containers(self) -> list[str]:
        return [str(c["container"]) for c in self.calls]


@pytest.fixture
def container_run(monkeypatch: pytest.MonkeyPatch) -> Callable[..., ContainerRunRecorder]:
    """Подменить `pssh_run_container` в указанных модулях и записывать вызовы.

    Модули передаются явно: часть команд импортирует функцию в своё пространство имён,
    и подмена в `mpu.lib.pssh` их не перехватит.
    """

    def _install(*targets: object, rc: int = 0) -> ContainerRunRecorder:
        recorder = ContainerRunRecorder(rc)
        for target in targets:
            monkeypatch.setattr(target, "pssh_run_container", recorder)
        return recorder

    return _install


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


@pytest.fixture(autouse=True)
def reset_servers_cache() -> Iterator[None]:
    """`servers._env` — `lru_cache` на процесс: без сброса `.env` одного теста виден следующему.

    Сброс делается здесь до и после каждого теста, чтобы тестам не приходилось помнить про это
    руками (раньше — 61 вызов `servers.reset_cache()` по файлам, и любой забытый протекал в соседа).
    """
    servers.reset_cache()
    yield
    servers.reset_cache()


@pytest.fixture
def pg_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Callable[..., Path]:
    """Записать временный `.env` и направить на него `servers.ENV_PATH` (+ изолировать SQLite).

    Содержимое `.env` — параметр: у каждого теста свой набор ключей (sl_N/pg_N, PG_*, PORTAINER_*),
    и это часть теста, а не общий шаблон. Возвращает путь к файлу — его дописывают в тестах парсера.
    """

    def _write(content: str = "", *, with_db: bool = True) -> Path:
        env_file = tmp_path / ".env"
        env_file.write_text(content, encoding="utf-8")
        monkeypatch.setattr(servers, "ENV_PATH", env_file)
        if with_db:
            monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
        servers.reset_cache()
        return env_file

    return _write


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
