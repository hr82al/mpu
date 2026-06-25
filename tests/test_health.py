"""Тесты `mpu/commands/health.py` — CLI-обёртка `mpu health` над Portainer.

Сетевой слой замокан на именованном шве `resolve_portainer` (возвращаем
duck-type `_FakeClient` вместо реального `portainer.Client`); часть тестов
гоняет реальный `_portainer_resolve` через изоляцию `.env` / SQLite, чтобы
покрыть ветки резолва селектора без обращения в сеть.
"""
# Тестируем module-private хелперы (_row / _is_one_shot_completed / _is_loader /
# _matches / _str_field / _print_table) — отсюда file-level подавление.
# pyright: reportPrivateUsage=false

from collections.abc import Iterator
from pathlib import Path
from typing import cast

import httpx
import pytest
from typer.testing import CliRunner

from mpu.commands import health
from mpu.commands._portainer_resolve import PortainerResolved
from mpu.lib import portainer, servers, store

runner = CliRunner()


# ── фейковый portainer.Client (только методы, которые трогает health) ──────────


class _FakeClient:
    """Duck-type `portainer.Client`: `list_containers` + `container_logs`.

    Запоминает аргументы `container_logs` в `log_calls` для проверки прокидывания
    `--tail` / `--since`.
    """

    def __init__(
        self,
        *,
        containers: list[dict[str, object]] | None = None,
        list_error: httpx.HTTPError | None = None,
        logs: tuple[bytes, bytes] = (b"", b""),
        logs_error: httpx.HTTPError | None = None,
    ) -> None:
        self._containers = containers if containers is not None else []
        self._list_error = list_error
        self._logs = logs
        self._logs_error = logs_error
        self.log_calls: list[dict[str, object]] = []

    def list_containers(self, endpoint_id: int) -> list[dict[str, object]]:
        _ = endpoint_id
        if self._list_error is not None:
            raise self._list_error
        return self._containers

    def container_logs(
        self,
        container: str,
        *,
        tail: int = 200,
        since: int | None = None,
        timestamps: bool = False,
        stdout: bool = True,
        stderr: bool = True,
    ) -> tuple[bytes, bytes]:
        self.log_calls.append(
            {
                "container": container,
                "tail": tail,
                "since": since,
                "timestamps": timestamps,
                "stdout": stdout,
                "stderr": stderr,
            }
        )
        if self._logs_error is not None:
            raise self._logs_error
        return self._logs


def _patch_resolve(
    monkeypatch: pytest.MonkeyPatch, client: _FakeClient, *, server_number: int = 2
) -> None:
    """Подменить `health.resolve_portainer` так, чтобы он отдал наш `_FakeClient`."""

    def _fake(*, selector: str, command_name: str) -> PortainerResolved:
        _ = selector, command_name
        # _FakeClient duck-типизирует только два используемых health метода;
        # cast удовлетворяет аннотацию PortainerResolved.client = portainer.Client.
        return PortainerResolved(
            server_number=server_number,
            client=cast(portainer.Client, client),
            endpoint_id=19,
        )

    monkeypatch.setattr(health, "resolve_portainer", _fake)


def _container(name: str, state: str, status: str, image: str = "img") -> dict[str, object]:
    """Элемент `docker ps` так, как его отдаёт Portainer `containers/json`."""
    return {"Names": [f"/{name}"], "State": state, "Status": status, "Image": image}


# ── happy path: всё running ───────────────────────────────────────────────────


def test_health_all_running_exit_0(monkeypatch: pytest.MonkeyPatch) -> None:
    """Все mp-* контейнеры running, loader'ов нет → exit 0, таблица, без tail-секции."""
    client = _FakeClient(
        containers=[
            _container("mp-sl-2-nats", "running", "Up 3 hours"),
            _container("mp-wb-pgbouncer", "running", "Up 3 hours"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "=== sl-2: 2 mp-* containers ===" in result.output
    assert "NAME" in result.output and "STATE" in result.output and "STATUS" in result.output
    assert "mp-sl-2-nats" in result.output
    assert "mp-wb-pgbouncer" in result.output
    # ни один не loader → нет блока с логами и нет вызовов container_logs
    assert "=== tail" not in result.output
    assert client.log_calls == []


# ── loader → tail логов ───────────────────────────────────────────────────────


def test_health_loader_tails_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    """Running loader → печатается tail-секция и stderr-содержимое."""
    client = _FakeClient(
        containers=[_container("mp-sl-2-wb-loader", "running", "Up 1 hour")],
        logs=(b"", b"stderr-line-here\n"),
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "=== tail --30 (stderr) for 1 container(s) ===" in result.output
    assert "--- mp-sl-2-wb-loader (stderr, tail=30) ---" in result.output
    assert "stderr-line-here" in result.output
    assert [c["container"] for c in client.log_calls] == ["mp-sl-2-wb-loader"]


def test_health_loader_no_stderr_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """Loader без stderr в окне → «(no stderr in window)», exit 0."""
    client = _FakeClient(
        containers=[_container("mp-sl-2-data-processor", "running", "Up")],
        logs=(b"some stdout\n", b""),
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "(no stderr in window)" in result.output


def test_health_loader_logs_http_error_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ошибка чтения логов loader'а → «(logs error: …)», continue, exit 0 (контейнер жив)."""
    client = _FakeClient(
        containers=[_container("mp-sl-2-ss-updater", "running", "Up")],
        logs_error=httpx.ConnectError("logs boom"),
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "(logs error:" in result.output


# ── one-shot контейнеры ───────────────────────────────────────────────────────


def test_health_one_shot_exited_zero_is_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """migrations с `Exited (0)` → блок «One-shot containers», не bad, exit 0, без tail."""
    client = _FakeClient(
        containers=[
            _container("mp-sl-2-nats", "running", "Up"),
            _container("mp-sl-2-migrations", "exited", "Exited (0) 5 minutes ago"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "✓ One-shot containers (completed normally):" in result.output
    assert "mp-sl-2-migrations: Exited (0) 5 minutes ago" in result.output
    assert "Containers not in 'running' state" not in result.output
    # one-shot исключён из daemons → не тейлится
    assert client.log_calls == []


def test_health_one_shot_exited_nonzero_is_bad(monkeypatch: pytest.MonkeyPatch) -> None:
    """migrations с `Exited (1)` → НЕ one-shot-ok, попадает в bad → exit 1."""
    client = _FakeClient(
        containers=[
            _container("mp-sl-2-nats", "running", "Up"),
            _container("mp-wb-sids-migrations", "exited", "Exited (1) 1 minute ago"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 1, result.output
    assert "⚠️  Containers not in 'running' state:" in result.output
    assert "mp-wb-sids-migrations" in result.output
    assert "One-shot containers (completed normally)" not in result.output


# ── bad daemon → exit 1 ───────────────────────────────────────────────────────


def test_health_dead_loader_is_bad_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    """Не-running не-one-shot контейнер → блок ⚠️ + exit 1."""
    client = _FakeClient(
        containers=[
            _container("mp-sl-2-nats", "running", "Up"),
            _container("mp-sl-2-wb-loader", "exited", "Exited (137) 2 minutes ago"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 1, result.output
    assert "⚠️  Containers not in 'running' state:" in result.output
    assert "state=exited status=Exited (137) 2 minutes ago" in result.output


# ── --all: tail для всех daemon'ов (кроме one-shot) ───────────────────────────


def test_health_all_logs_tails_every_daemon(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--all` тейлит все mp-* daemon'ы, но one-shot (migrations) исключён."""
    client = _FakeClient(
        containers=[
            _container("mp-sl-2-nats", "running", "Up"),
            _container("mp-sl-2-redis", "running", "Up"),
            _container("mp-sl-2-migrations", "exited", "Exited (0) ago"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2", "--all"])
    assert result.exit_code == 0, result.output
    tailed = [c["container"] for c in client.log_calls]
    assert "mp-sl-2-nats" in tailed
    assert "mp-sl-2-redis" in tailed
    assert "mp-sl-2-migrations" not in tailed


# ── --since / --tail прокидываются в container_logs ───────────────────────────


def test_health_since_and_tail_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--since 30m --tail 5` → container_logs(tail=5, since=<int-ts>, stderr-only, ts=on)."""
    client = _FakeClient(
        containers=[_container("mp-sl-2-wb-loader", "running", "Up")],
        logs=(b"", b"errdata\n"),
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2", "--since", "30m", "--tail", "5"])
    assert result.exit_code == 0, result.output
    assert "errdata" in result.output
    call = client.log_calls[0]
    assert call["tail"] == 5
    assert isinstance(call["since"], int)
    assert call["stdout"] is False
    assert call["stderr"] is True
    assert call["timestamps"] is True


def test_health_invalid_since_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """Невалидный `--since` → exit 2, container_logs не вызывается."""
    client = _FakeClient(containers=[_container("mp-sl-2-wb-loader", "running", "Up")])
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2", "--since", "garbage"])
    assert result.exit_code == 2, result.output
    assert "--since" in result.output
    assert client.log_calls == []


# ── HTTP error на list_containers → exit 1 ────────────────────────────────────


def test_health_list_containers_http_error_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient(list_error=httpx.ConnectError("portainer down"))
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 1, result.output
    assert "portainer error" in result.output


# ── пустой / мусорный ввод от Portainer ───────────────────────────────────────


def test_health_empty_container_list(monkeypatch: pytest.MonkeyPatch) -> None:
    """Portainer вернул пустой список → exit 0, «0 mp-* containers», только заголовки."""
    client = _FakeClient(containers=[])
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "=== sl-2: 0 mp-* containers ===" in result.output
    assert "NAME" in result.output
    assert client.log_calls == []


def test_health_no_mp_containers_falls_back_to_all_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет mp-* контейнеров → таблица печатает все строки (fallback `mp_rows or rows`)."""
    client = _FakeClient(containers=[_container("other-service", "running", "Up")])
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "=== sl-2: 0 mp-* containers ===" in result.output
    assert "other-service" in result.output
    assert client.log_calls == []


def test_health_garbage_items_filtered(monkeypatch: pytest.MonkeyPatch) -> None:
    """Элементы без валидного `Names` отбрасываются, остаётся один реальный mp-*."""
    client = _FakeClient(
        containers=[
            {"State": "running", "Status": "Up"},  # нет Names → name "" → drop
            {"Names": [], "State": "running", "Status": "Up"},  # пустой список → drop
            {"Names": [123], "State": "running", "Status": "Up"},  # первый не str → drop
            {"Names": "not-a-list", "State": "running", "Status": "Up"},  # не list → drop
            _container("mp-sl-2-nats", "running", "Up"),
        ]
    )
    _patch_resolve(monkeypatch, client)
    result = runner.invoke(health.app, ["sl-2"])
    assert result.exit_code == 0, result.output
    assert "=== sl-2: 1 mp-* containers ===" in result.output
    assert "mp-sl-2-nats" in result.output


# ── резолв селектора (реальный _portainer_resolve, без сети) ───────────────────


@pytest.fixture
def env_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Пустой `.env` + изолированный (несуществующий) SQLite — никакого prod-конфига."""
    p = tmp_path / ".env"
    p.write_text("", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", p)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    yield
    servers.reset_cache()


def test_health_no_portainer_target_exit_2(env_empty: None) -> None:
    """sl-99 без portainer-target в SQLite/.env → exit 2 (реальный resolve_portainer)."""
    _ = env_empty
    result = runner.invoke(health.app, ["sl-99"])
    assert result.exit_code == 2, result.output
    assert "portainer-target" in result.output


def test_health_rejects_sl_0(env_empty: None) -> None:
    """sl-0 не cli-таргет → exit 2 «ожидается sl-N (N>0)»."""
    _ = env_empty
    result = runner.invoke(health.app, ["sl-0"])
    assert result.exit_code == 2, result.output
    assert "sl-N" in result.output


def test_health_missing_api_key_exit_2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Portainer-target есть, но нет PORTAINER_API_KEY → exit 2 (до конструирования клиента)."""
    p = tmp_path / ".env"
    p.write_text("sl_99_portainer=https://192.168.150.12:9443/19\n", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", p)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    try:
        result = runner.invoke(health.app, ["sl-99"])
        assert result.exit_code == 2, result.output
        assert "PORTAINER_API_KEY" in result.output
    finally:
        servers.reset_cache()


# ── module-private хелперы ────────────────────────────────────────────────────


def test_row_strips_leading_slash() -> None:
    row = health._row(_container("mp-sl-2-nats", "running", "Up 2h", image="repo:tag"))
    assert row == {
        "name": "mp-sl-2-nats",
        "state": "running",
        "status": "Up 2h",
        "image": "repo:tag",
    }


def test_row_handles_missing_and_garbage_fields() -> None:
    assert health._row({})["name"] == ""
    assert health._row({"Names": "not-a-list"})["name"] == ""
    assert health._row({"Names": []})["name"] == ""
    assert health._row({"Names": [123]})["name"] == ""
    # не-строковые State/Status → пустые строки
    bad = health._row({"Names": ["/x"], "State": 1, "Status": None})
    assert bad == {"name": "x", "state": "", "status": "", "image": ""}


def test_str_field() -> None:
    assert health._str_field({"k": "v"}, "k") == "v"
    assert health._str_field({"k": 5}, "k") == ""
    assert health._str_field({}, "k") == ""


def test_matches_is_case_insensitive_substring() -> None:
    assert health._matches("MP-SL-2-WB-LOADER", ("loader",)) is True
    assert health._matches("mp-sl-2-nats", ("loader", "workers")) is False
    assert health._matches("mp-sl-2-nats-listeners", ("nats-listeners",)) is True


def test_is_loader_keywords() -> None:
    assert health._is_loader("mp-sl-2-wb-loader") is True
    assert health._is_loader("mp-sl-2-data-processor") is True
    assert health._is_loader("mp-sl-2-instance-app") is True
    assert health._is_loader("mp-sl-2-main-app") is True
    assert health._is_loader("mp-sl-2-nats") is False
    assert health._is_loader("mp-sl-2-redis") is False


def test_is_one_shot_completed() -> None:
    assert (
        health._is_one_shot_completed(
            {"name": "mp-sl-2-migrations", "state": "exited", "status": "Exited (0) 1m ago"}
        )
        is True
    )
    # exited, но не из one-shot набора
    assert (
        health._is_one_shot_completed(
            {"name": "mp-sl-2-wb-loader", "state": "exited", "status": "Exited (0) 1m ago"}
        )
        is False
    )
    # one-shot имя, но Exited (≠0)
    assert (
        health._is_one_shot_completed(
            {"name": "mp-sl-2-migrations", "state": "exited", "status": "Exited (1) 1m ago"}
        )
        is False
    )
    # one-shot имя, но всё ещё running
    assert (
        health._is_one_shot_completed(
            {"name": "mp-sl-2-init-job", "state": "running", "status": "Up"}
        )
        is False
    )


def test_print_table_aligns_columns(capsys: pytest.CaptureFixture[str]) -> None:
    health._print_table(
        [
            {"name": "short", "state": "running", "status": "Up 1h"},
            {"name": "a-very-long-container-name", "state": "exited", "status": "Exited (0)"},
        ]
    )
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0].startswith("NAME")
    # колонка NAME шире самого длинного имени → строки выровнены по одной ширине
    assert "a-very-long-container-name" in out
    assert len(lines) == 3  # заголовок + 2 строки
    assert all(len(line) == len(lines[0]) for line in lines)
