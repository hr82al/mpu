"""Тесты `mpu/commands/ps.py` — статусы Docker-контейнеров.

Два пути:
- без селектора — чтение из SQLite-кэша `portainer_containers` (изолируем `DB_PATH`
  на tmp + bootstrap, сидируем строки);
- с селектором — live-запрос к Portainer (мокаем `resolve_portainer` у call-site
  и подставляем stub-клиент, без сети).

`# pyright: reportPrivateUsage=false` — тестируем `_row` (underscore-helper) напрямую,
чтобы покрыть разбор мусорных `Names`/полей.
"""
# pyright: reportPrivateUsage=false

import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from mpu.commands import ps
from mpu.lib import store

runner = CliRunner()


# ── изоляция SQLite-кэша ──────────────────────────────────────────────────────


@pytest.fixture
def isolated_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bootstrap_db: Callable[[Path | str], None],
) -> Iterator[None]:
    """Подменить `store.DB_PATH` на tmp и создать схему — иначе читаем prod mpu.db."""
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    bootstrap_db(store.DB_PATH)
    yield


@pytest.fixture
def bare_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Изолировать `DB_PATH` БЕЗ bootstrap — таблиц нет (для ветки SQLite-ошибки)."""
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    yield


def _seed_container(
    *,
    endpoint_name: str | None,
    container_name: str,
    state: str | None,
    image: str | None,
    url: str = "https://p:9443",
    endpoint_id: int = 19,
    container_id: str | None = None,
) -> None:
    # container_id входит в PK — по умолчанию делаем уникальным от имени.
    container_id = container_id or container_name
    params = (
        url,
        endpoint_id,
        endpoint_name,
        container_id,
        container_name,
        None,
        state,
        image,
        100,
    )
    with store.store() as conn:
        conn.execute(
            "INSERT INTO portainer_containers "
            "(portainer_url, endpoint_id, endpoint_name, container_id, container_name, "
            " server_number, state, image, discovered_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params,
        )
        conn.commit()


# ── live-путь: stub Portainer-клиента + подмена resolve_portainer ─────────────


class _StubPortainerClient:
    """Подменяет `portainer.Client` в live-ветке: отдаёт заранее заданные items
    или бросает httpx.HTTPError. Запоминает endpoint_id вызовов."""

    def __init__(
        self,
        *,
        items: list[dict[str, object]] | None = None,
        error: httpx.HTTPError | None = None,
    ) -> None:
        self._items = items if items is not None else []
        self._error = error
        self.endpoint_ids: list[int] = []

    def list_containers(self, endpoint_id: int) -> list[dict[str, object]]:
        self.endpoint_ids.append(endpoint_id)
        if self._error is not None:
            raise self._error
        return self._items


@dataclass
class _FakeResolved:
    client: _StubPortainerClient
    endpoint_id: int


def _patch_resolve(
    monkeypatch: pytest.MonkeyPatch,
    client: _StubPortainerClient,
    *,
    endpoint_id: int = 19,
) -> None:
    def _fake(*, selector: str, command_name: str) -> _FakeResolved:
        _ = selector, command_name
        return _FakeResolved(client=client, endpoint_id=endpoint_id)

    monkeypatch.setattr(ps, "resolve_portainer", _fake)


# ── cache-путь (без селектора) ────────────────────────────────────────────────


def test_cache_empty_prints_hint_exit0(isolated_db: None) -> None:
    """Пустой кэш → подсказка в stderr, exit 0, пустой stdout."""
    _ = isolated_db
    result = runner.invoke(ps.app, [])
    assert result.exit_code == 0, result.output
    assert "(no containers in cache" in result.output
    assert result.stdout == ""


def test_cache_table_lists_containers(isolated_db: None) -> None:
    _ = isolated_db
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-cli", state="running", image="img"
    )
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-wb-loader", state="exited", image="img"
    )
    result = runner.invoke(ps.app, [])
    assert result.exit_code == 0, result.output
    # Заголовки таблицы + cache-предупреждение.
    assert "ENDPOINT" in result.stdout
    assert "NAME" in result.stdout
    assert "mp-sl-2-cli" in result.stdout
    assert "mp-sl-2-wb-loader" in result.stdout
    assert "# кэш" in result.output


def test_cache_json_structure(isolated_db: None) -> None:
    _ = isolated_db
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-cli", state="running", image="img"
    )
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-wb-loader", state="exited", image="img"
    )
    result = runner.invoke(ps.app, ["--json"])
    assert result.exit_code == 0, result.output
    parsed: object = json.loads(result.stdout)
    # DISTINCT + ORDER BY endpoint_name, container_name; ключи endpoint/name/state/image.
    assert parsed == [
        {"endpoint": "ep-a", "name": "mp-sl-2-cli", "state": "running", "image": "img"},
        {"endpoint": "ep-a", "name": "mp-sl-2-wb-loader", "state": "exited", "image": "img"},
    ]


def test_cache_tsv_format(isolated_db: None) -> None:
    _ = isolated_db
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-cli", state="running", image="img"
    )
    result = runner.invoke(ps.app, ["--tsv"])
    assert result.exit_code == 0, result.output
    assert result.stdout.splitlines() == ["ep-a\tmp-sl-2-cli\trunning\timg"]


def test_cache_name_filter(isolated_db: None) -> None:
    """`--filter` транслируется в SQL `LIKE %substr%` — режет по подстроке имени."""
    _ = isolated_db
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-cli", state="running", image="img"
    )
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-wb-loader", state="exited", image="img"
    )
    result = runner.invoke(ps.app, ["--filter", "cli", "--json"])
    assert result.exit_code == 0, result.output
    parsed: object = json.loads(result.stdout)
    assert parsed == [
        {"endpoint": "ep-a", "name": "mp-sl-2-cli", "state": "running", "image": "img"}
    ]


def test_cache_null_fields_normalized(isolated_db: None) -> None:
    """endpoint_name=NULL → "?"; state/image=NULL → "" (не пропуск ключа)."""
    _ = isolated_db
    _seed_container(endpoint_name=None, container_name="solo", state=None, image=None)
    result = runner.invoke(ps.app, ["--json"])
    assert result.exit_code == 0, result.output
    parsed: object = json.loads(result.stdout)
    assert parsed == [{"endpoint": "?", "name": "solo", "state": "", "image": ""}]


def test_cache_idempotent(isolated_db: None) -> None:
    """Два чтения подряд — одинаковый stdout (read-only, без мутаций)."""
    _ = isolated_db
    _seed_container(
        endpoint_name="ep-a", container_name="mp-sl-2-cli", state="running", image="img"
    )
    first = runner.invoke(ps.app, ["--json"])
    second = runner.invoke(ps.app, ["--json"])
    assert first.exit_code == 0
    assert second.exit_code == 0
    assert first.stdout == second.stdout


def test_cache_sqlite_error_exit1(bare_db: None) -> None:
    """Таблицы нет (не запускали bootstrap) → SQLite-ошибка в stderr, exit 1."""
    _ = bare_db
    result = runner.invoke(ps.app, [])
    assert result.exit_code == 1
    assert "SQLite error" in result.output


# ── live-путь (с селектором) ──────────────────────────────────────────────────


def _live_items() -> list[dict[str, object]]:
    # Намеренно не отсортированы — проверяем сортировку по name.
    return [
        {
            "Names": ["/mp-sl-2-wb-loader"],
            "State": "exited",
            "Status": "Exited (0) 2h ago",
            "Image": "mp-back",
        },
        {
            "Names": ["/mp-sl-2-cli"],
            "State": "running",
            "Status": "Up 3 hours",
            "Image": "mp-back",
        },
    ]


def test_live_table_sorted(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _StubPortainerClient(items=_live_items())
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "STATUS" in out  # live-таблица содержит STATUS-колонку
    # cli отсортирован раньше wb-loader.
    assert out.index("mp-sl-2-cli") < out.index("mp-sl-2-wb-loader")
    # endpoint_id проброшен в клиент.
    assert client.endpoint_ids == [19]


def test_live_json_includes_status(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _StubPortainerClient(items=_live_items())
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2", "--json"])
    assert result.exit_code == 0, result.output
    parsed: object = json.loads(result.stdout)
    assert parsed == [
        {
            "name": "mp-sl-2-cli",
            "state": "running",
            "status": "Up 3 hours",
            "image": "mp-back",
        },
        {
            "name": "mp-sl-2-wb-loader",
            "state": "exited",
            "status": "Exited (0) 2h ago",
            "image": "mp-back",
        },
    ]


def test_live_tsv_format(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _StubPortainerClient(items=_live_items())
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2", "--tsv"])
    assert result.exit_code == 0, result.output
    assert result.stdout.splitlines() == [
        "mp-sl-2-cli\trunning\tUp 3 hours\tmp-back",
        "mp-sl-2-wb-loader\texited\tExited (0) 2h ago\tmp-back",
    ]


def test_live_name_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _StubPortainerClient(items=_live_items())
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2", "--filter", "cli", "--json"])
    assert result.exit_code == 0, result.output
    parsed: object = json.loads(result.stdout)
    assert parsed == [
        {"name": "mp-sl-2-cli", "state": "running", "status": "Up 3 hours", "image": "mp-back"}
    ]


def test_live_http_error_exit1(monkeypatch: pytest.MonkeyPatch) -> None:
    """list_containers бросает httpx.HTTPError → stderr + exit 1."""
    client = _StubPortainerClient(error=httpx.HTTPError("portainer down"))
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2"])
    assert result.exit_code == 1
    assert "portainer error" in result.output


def test_live_empty_no_containers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой ответ Portainer → "(no containers)" в таблице, exit 0."""
    client = _StubPortainerClient(items=[])
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "(no containers)" in result.stdout


def test_live_has_no_cache_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live-вывод не несёт cache-предупреждения (это маркер ветки кэша)."""
    client = _StubPortainerClient(items=_live_items())
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(ps.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "# кэш" not in result.output


# ── _row: разбор Names / мусорных полей ───────────────────────────────────────


def test_row_parses_names_strips_slash() -> None:
    row = ps._row({"Names": ["/foo"], "State": "running", "Status": "Up 1m", "Image": "img"})
    assert row == {"name": "foo", "state": "running", "status": "Up 1m", "image": "img"}


def test_row_missing_and_garbage_fields_default_empty() -> None:
    assert ps._row({}) == {"name": "", "state": "", "status": "", "image": ""}
    # Names не список → name "".
    assert ps._row({"Names": "notalist"})["name"] == ""
    # Пустой список Names → name "".
    assert ps._row({"Names": []})["name"] == ""
    # Первый элемент не строка → name "".
    assert ps._row({"Names": [123]})["name"] == ""
    # Не-строковые State/Image → "".
    garbage = ps._row({"Names": ["/x"], "State": 5, "Image": None})
    assert garbage == {"name": "x", "state": "", "status": "", "image": ""}
