"""Smoke-тест верхнего уровня CLI + unit-тесты cli.py (mount/init/main)."""
# Тесты дёргают приватный хелпер cli.py (_mount) — отключаем reportPrivateUsage.
# pyright: reportPrivateUsage=false

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import click
import pytest
import typer
from typer.testing import CliRunner

from mpu import __version__, cli
from mpu.cli import app
from mpu.cli_registry import COMMANDS
from mpu.commands import telegram as telegram_cmd_module
from mpu.lib import kaiten_cache, loki_discover, portainer_discover, servers, store
from mpu.lib.kaiten import KaitenBoard, KaitenColumn, KaitenLane, KaitenSpace

runner = CliRunner()


def test_help() -> None:
    """Проверяет: `mpu --help` возвращает 0 и содержит описание утилиты."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "Monorepo Python utilities" in result.stdout


def test_version() -> None:
    """Проверяет: `mpu version` печатает текущий __version__."""
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


# ── Общие фейки / хелперы ─────────────────────────────────────────────────────

_ITEM = portainer_discover.DiscoveredContainer(
    portainer_url="https://example:9443",
    endpoint_id=1,
    endpoint_name="local",
    container_id="abc",
    container_name="mp-sl-1-cli",
    server_number=1,
    state="running",
    image="node:22",
)


def _fake_discover(client: object) -> list[portainer_discover.DiscoveredContainer]:
    _ = client
    return [_ITEM]


def _fake_discover_empty(client: object) -> list[portainer_discover.DiscoveredContainer]:
    _ = client
    return []


@pytest.fixture
def init_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """.env с Portainer-кредами + tmp `mpu.db`. Сами discovery-сетевые вызовы мокаются в тесте."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "PORTAINER_API_KEY=k\nPORTAINER_URL=https://example:9443\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", env_file)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    yield env_file


# ── _mount: single-command напрямую vs multi-command через add_typer ──────────


def test_mount_single_vs_multi() -> None:
    """`search` (1 команда) → `app.command()`; `kiten` (N команд) → `add_typer`."""
    parent = typer.Typer()
    registry: dict[str, tuple[str, str]] = {
        "search": ("mpu.commands.search", "app"),
        "kiten": ("mpu.commands.kiten", "app"),
    }
    cli._mount(parent, registry)
    command_names = {c.name for c in parent.registered_commands}
    group_names = {g.name for g in parent.registered_groups}
    assert "search" in command_names
    assert "search" not in group_names
    assert "kiten" in group_names
    assert "kiten" not in command_names


def test_all_registry_commands_listed() -> None:
    """Все kebab-имена из COMMANDS + version/init/api видны в root click-группе.

    Группа ленивая: имена берутся из реестра без импорта модулей, поэтому проверяем
    `list_commands`, а не `.commands` (тот наполняется по мере обращения)."""
    cmd = typer.main.get_command(cli.app)
    assert isinstance(cmd, click.Group)
    names = set(cmd.list_commands(click.Context(cmd)))
    for kebab in COMMANDS:
        assert kebab in names, kebab
    assert {"version", "init", "api"} <= names
    # kebab-имена сохраняются как есть (не snake_case).
    assert "sql-ro" in names
    assert "backup-wb-unit-proto" in names


def test_lazy_command_is_built_on_demand() -> None:
    """Обращение к команде импортирует её модуль и кэширует результат в группе."""
    group = cast(click.Group, typer.main.get_command(cli.app))
    ctx = click.Context(group)
    assert "sql-ro" not in group.commands  # до обращения — не смонтирована
    built = group.get_command(ctx, "sql-ro")
    assert built is not None
    assert group.commands["sql-ro"] is built  # повторное обращение — из кэша
    assert group.get_command(ctx, "нет-такой-команды") is None


# ── main(): typer→click мост + добавление api-группы ──────────────────────────


def test_main_runs_version(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """main() конвертирует Typer-app в click и исполняет `version` (SystemExit 0)."""
    monkeypatch.setattr(sys, "argv", ["mpu", "version"])
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out


def test_main_adds_api_group(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """main() добавляет click-группу `api` поверх сконвертированного Typer-app."""
    monkeypatch.setattr(sys, "argv", ["mpu", "api", "--help"])
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == 0
    assert "sl-back" in capsys.readouterr().out


# ── mpu init: discovery best-effort оркестрация ───────────────────────────────


def test_init_no_containers_exits_1(init_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой discover → exit 1 с понятным сообщением."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover_empty)
    monkeypatch.setattr(telegram_cmd_module, "run_login_step", lambda: None)
    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 1
    assert "ни одного контейнера не найдено" in result.output


def test_init_discovery_errors_do_not_fail(init_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Loki/Kaiten вернули ошибку → init всё равно exit 0 и пишет контейнеры."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover)
    monkeypatch.setattr(telegram_cmd_module, "run_login_step", lambda: None)

    def loki_err() -> loki_discover.DiscoveryResult:
        return loki_discover.DiscoveryResult(
            hosts=[], services_by_host={}, error="LOKI_URL не задан"
        )

    def kaiten_err() -> kaiten_cache.KaitenDiscoveryResult:
        return kaiten_cache.KaitenDiscoveryResult(
            spaces=[], boards=[], error="KITEN_API_KEY не задан"
        )

    monkeypatch.setattr(loki_discover, "discover_and_store", loki_err)
    monkeypatch.setattr(kaiten_cache, "discover_and_store", kaiten_err)

    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert "loki: пропущено" in result.output
    assert "kaiten: пропущено" in result.output
    with store.store(store.DB_PATH) as conn:
        n = conn.execute("SELECT COUNT(*) FROM portainer_containers").fetchone()[0]
        assert n == 1


def test_init_discovery_success_prints_summary(
    init_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Успешный discovery → сводки Loki/Kaiten (включая lanes/columns) в выводе."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover)
    monkeypatch.setattr(telegram_cmd_module, "run_login_step", lambda: None)

    def loki_ok() -> loki_discover.DiscoveryResult:
        return loki_discover.DiscoveryResult(
            hosts=["h1"], services_by_host={"h1": ["s1", "s2"]}, error=None
        )

    def kaiten_ok() -> kaiten_cache.KaitenDiscoveryResult:
        return kaiten_cache.KaitenDiscoveryResult(
            spaces=[KaitenSpace(id=1, title="S", archived=False)],
            boards=[KaitenBoard(id=10, space_id=1, title="B")],
            error=None,
        )

    def lanes_ok(board_ids: list[int]) -> kaiten_cache.KaitenLanesResult:
        _ = board_ids
        return kaiten_cache.KaitenLanesResult(
            lanes=[KaitenLane(id=100, board_id=10, title="L")], error=None
        )

    def columns_ok(board_ids: list[int]) -> kaiten_cache.KaitenColumnsResult:
        _ = board_ids
        return kaiten_cache.KaitenColumnsResult(
            columns=[KaitenColumn(id=200, board_id=10, title="C")], error=None
        )

    monkeypatch.setattr(loki_discover, "discover_and_store", loki_ok)
    monkeypatch.setattr(kaiten_cache, "discover_and_store", kaiten_ok)
    monkeypatch.setattr(kaiten_cache, "discover_lanes_and_store", lanes_ok)
    monkeypatch.setattr(kaiten_cache, "discover_columns_and_store", columns_ok)

    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert "loki: 1 hosts, 2 (host, service) пар" in result.output
    assert "kaiten: 1 spaces, 1 boards, 1 lanes, 1 columns" in result.output


def test_init_kaiten_lanes_columns_error_marked_unknown(
    init_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """spaces/boards есть, но lanes/columns упали → счётчики помечены '?'."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover)
    monkeypatch.setattr(telegram_cmd_module, "run_login_step", lambda: None)
    monkeypatch.setattr(
        loki_discover,
        "discover_and_store",
        lambda: loki_discover.DiscoveryResult(hosts=[], services_by_host={}, error="x"),
    )

    def kaiten_ok() -> kaiten_cache.KaitenDiscoveryResult:
        return kaiten_cache.KaitenDiscoveryResult(
            spaces=[KaitenSpace(id=1, title="S", archived=False)],
            boards=[KaitenBoard(id=10, space_id=1, title="B")],
            error=None,
        )

    def lanes_err(board_ids: list[int]) -> kaiten_cache.KaitenLanesResult:
        _ = board_ids
        return kaiten_cache.KaitenLanesResult(lanes=[], error="boom")

    def columns_err(board_ids: list[int]) -> kaiten_cache.KaitenColumnsResult:
        _ = board_ids
        return kaiten_cache.KaitenColumnsResult(columns=[], error="boom")

    monkeypatch.setattr(kaiten_cache, "discover_and_store", kaiten_ok)
    monkeypatch.setattr(kaiten_cache, "discover_lanes_and_store", lanes_err)
    monkeypatch.setattr(kaiten_cache, "discover_columns_and_store", columns_err)

    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert "kaiten: 1 spaces, 1 boards, ? lanes, ? columns" in result.output
