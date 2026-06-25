"""Smoke-тест верхнего уровня CLI + unit-тесты cli.py (mount/init/telegram-helpers/main)."""
# Тесты дёргают приватные хелперы cli.py (_mount / _ask* / _read_stdin_line /
# _ensure_telegram_creds / _telegram_login_step) — отключаем reportPrivateUsage.
# pyright: reportPrivateUsage=false

import io
import sys
from collections.abc import Iterator
from pathlib import Path

import click
import pytest
import typer
from typer.testing import CliRunner

from mpu import __version__, cli
from mpu.cli import app
from mpu.cli_registry import COMMANDS
from mpu.lib import env, kaiten_cache, loki_discover, portainer_discover, servers, store, telegram
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


class _FakeStdin:
    """Подмена `sys.stdin`: байтовый `buffer.readline()` + управляемый `isatty()`."""

    def __init__(self, data: bytes = b"", *, tty: bool = False) -> None:
        self.buffer = io.BytesIO(data)
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _set_env_get(monkeypatch: pytest.MonkeyPatch, values: dict[str, str | None]) -> None:
    """Подменить `env.get` детерминированной таблицей (всё незаданное → default)."""

    def fake_get(name: str, default: str | None = None) -> str | None:
        return values.get(name, default)

    monkeypatch.setattr(env, "get", fake_get)


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
    servers.reset_cache()


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


def test_all_registry_commands_mounted() -> None:
    """Все kebab-имена из COMMANDS + version/init смонтированы в root click-группу."""
    cmd = typer.main.get_command(cli.app)
    assert isinstance(cmd, click.Group)
    names = set(cmd.commands)
    for kebab in COMMANDS:
        assert kebab in names, kebab
    assert "version" in names
    assert "init" in names
    # kebab-имена сохраняются как есть (не snake_case).
    assert "sql-ro" in names
    assert "backup-wb-unit-proto" in names


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


# ── _read_stdin_line ──────────────────────────────────────────────────────────


def test_read_stdin_line_strips(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "stdin", _FakeStdin(b"  hello \n"))
    assert cli._read_stdin_line() == "hello"


def test_read_stdin_line_eof_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """EOF (пустой buffer) → пустая строка, не исключение."""
    monkeypatch.setattr(sys, "stdin", _FakeStdin(b""))
    assert cli._read_stdin_line() == ""


def test_read_stdin_line_replaces_bad_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Битые utf-8 байты заменяются на U+FFFD, без UnicodeDecodeError."""
    monkeypatch.setattr(sys, "stdin", _FakeStdin(b"\xff\xfe\n"))
    assert cli._read_stdin_line() == "��"


# ── _ask / _ask_yes_no / _ask_secret ──────────────────────────────────────────


def test_ask_returns_stdin_line(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "_read_stdin_line", lambda: "answer")
    assert cli._ask("Question: ") == "answer"
    assert "Question:" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("y", True),
        ("yes", True),
        ("Y", True),
        ("YES", True),
        ("n", False),
        ("", False),
        ("nope", False),
    ],
)
def test_ask_yes_no(monkeypatch: pytest.MonkeyPatch, answer: str, expected: bool) -> None:
    monkeypatch.setattr(cli, "_read_stdin_line", lambda: answer)
    assert cli._ask_yes_no("OK?") is expected


def test_ask_secret_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """getpass-путь: значение возвращается обрезанным."""
    import getpass

    def fake_getpass(prompt: str = "") -> str:
        _ = prompt
        return "  secret  "

    monkeypatch.setattr(getpass, "getpass", fake_getpass)
    assert cli._ask_secret("pw: ") == "secret"


def test_ask_secret_fallback_on_oserror(monkeypatch: pytest.MonkeyPatch) -> None:
    """getpass упал (нет TTY) → деградация в видимый ввод через _ask."""
    import getpass

    def raising(prompt: str = "") -> str:
        _ = prompt
        raise OSError("no tty")

    monkeypatch.setattr(getpass, "getpass", raising)
    monkeypatch.setattr(cli, "_read_stdin_line", lambda: "typed")
    assert cli._ask_secret("pw: ") == "typed"


# ── _ensure_telegram_creds ────────────────────────────────────────────────────


def test_ensure_creds_short_circuit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Креды уже в env → True без вопросов."""
    _set_env_get(monkeypatch, {"TELEGRAM_API_ID": "1", "TELEGRAM_API_HASH": "h"})
    assert cli._ensure_telegram_creds() is True


def test_ensure_creds_user_declines(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _set_env_get(monkeypatch, {})

    def no(label: str) -> bool:
        _ = label
        return False

    monkeypatch.setattr(cli, "_ask_yes_no", no)
    assert cli._ensure_telegram_creds() is False
    assert "пропущено" in capsys.readouterr().err


def test_ensure_creds_empty_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """Согласился, но ввёл пусто → False, без записи."""
    _set_env_get(monkeypatch, {})

    def yes(label: str) -> bool:
        _ = label
        return True

    def empty(label: str) -> str:
        _ = label
        return ""

    monkeypatch.setattr(cli, "_ask_yes_no", yes)
    monkeypatch.setattr(cli, "_ask", empty)
    monkeypatch.setattr(env, "set_persistent", _must_not_write)
    assert cli._ensure_telegram_creds() is False


def test_ensure_creds_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Согласился и ввёл значения → пишет оба ключа через set_persistent, возвращает True."""
    _set_env_get(monkeypatch, {})

    def yes(label: str) -> bool:
        _ = label
        return True

    def val(label: str) -> str:
        _ = label
        return "value"

    saved: dict[str, str] = {}

    def fake_set(name: str, value: str) -> None:
        saved[name] = value

    monkeypatch.setattr(cli, "_ask_yes_no", yes)
    monkeypatch.setattr(cli, "_ask", val)
    monkeypatch.setattr(env, "set_persistent", fake_set)
    assert cli._ensure_telegram_creds() is True
    assert saved["TELEGRAM_API_ID"] == "value"
    assert saved["TELEGRAM_API_HASH"] == "value"


def _must_not_write(name: str, value: str) -> None:
    raise AssertionError(f"set_persistent не должен вызываться ({name}={value})")


# ── _telegram_login_step ──────────────────────────────────────────────────────


def test_telegram_login_step_already_authorized(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _set_env_get(monkeypatch, {"TELEGRAM_SESSION": "sess"})
    cli._telegram_login_step()
    assert "уже авторизован" in capsys.readouterr().err


def test_telegram_login_step_no_tty(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _set_env_get(monkeypatch, {})
    monkeypatch.setattr(sys, "stdin", _FakeStdin(tty=False))
    cli._telegram_login_step()
    assert "нет TTY" in capsys.readouterr().err


def test_telegram_login_step_creds_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет creds и пользователь отказался → тихий выход (без падения)."""
    _set_env_get(monkeypatch, {})
    monkeypatch.setattr(sys, "stdin", _FakeStdin(tty=True))
    monkeypatch.setattr(cli, "_ensure_telegram_creds", lambda: False)
    monkeypatch.setattr(env, "set_persistent", _must_not_write)
    cli._telegram_login_step()


def test_telegram_login_step_success(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Полный happy-path: спрашиваем телефон, логинимся, пишем phone+session."""
    _set_env_get(monkeypatch, {})  # SESSION и PHONE отсутствуют
    monkeypatch.setattr(sys, "stdin", _FakeStdin(tty=True))
    monkeypatch.setattr(cli, "_ensure_telegram_creds", lambda: True)

    def fake_from_env() -> telegram.TgConfig:
        return telegram.TgConfig(api_id=1, api_hash="h", session=None)

    monkeypatch.setattr(telegram.TgConfig, "from_env", staticmethod(fake_from_env))

    def ask_phone(label: str) -> str:
        _ = label
        return "+79990001122"

    monkeypatch.setattr(cli, "_ask", ask_phone)

    async def fake_login(
        cfg: telegram.TgConfig, *, phone: str, prompt_code: object, prompt_password: object
    ) -> str:
        _ = (cfg, phone, prompt_code, prompt_password)
        return "SESSIONXYZ"

    monkeypatch.setattr(telegram, "interactive_login", fake_login)

    saved: dict[str, str] = {}

    def fake_set(name: str, value: str) -> None:
        saved[name] = value

    monkeypatch.setattr(env, "set_persistent", fake_set)

    cli._telegram_login_step()
    assert "авторизован" in capsys.readouterr().err
    assert saved["TELEGRAM_PHONE"] == "+79990001122"
    assert saved["TELEGRAM_SESSION"] == "SESSIONXYZ"


def test_telegram_login_step_tg_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """TgError при входе → best-effort пропуск (init не падает)."""
    _set_env_get(monkeypatch, {"TELEGRAM_PHONE": "+700"})  # SESSION нет → пробуем вход
    monkeypatch.setattr(sys, "stdin", _FakeStdin(tty=True))
    monkeypatch.setattr(cli, "_ensure_telegram_creds", lambda: True)

    def fake_from_env() -> telegram.TgConfig:
        return telegram.TgConfig(api_id=1, api_hash="h", session=None)

    monkeypatch.setattr(telegram.TgConfig, "from_env", staticmethod(fake_from_env))

    async def fake_login_err(
        cfg: telegram.TgConfig, *, phone: str, prompt_code: object, prompt_password: object
    ) -> str:
        _ = (cfg, phone, prompt_code, prompt_password)
        raise telegram.TgError("boom")

    monkeypatch.setattr(telegram, "interactive_login", fake_login_err)
    cli._telegram_login_step()
    assert "пропущено (boom)" in capsys.readouterr().err


# ── mpu init: discovery best-effort оркестрация ───────────────────────────────


def test_init_no_containers_exits_1(init_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой discover → exit 1 с понятным сообщением."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover_empty)
    monkeypatch.setattr(cli, "_telegram_login_step", lambda: None)
    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 1
    assert "ни одного контейнера не найдено" in result.output


def test_init_discovery_errors_do_not_fail(init_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Loki/Kaiten вернули ошибку → init всё равно exit 0 и пишет контейнеры."""
    _ = init_env
    monkeypatch.setattr(portainer_discover, "discover", _fake_discover)
    monkeypatch.setattr(cli, "_telegram_login_step", lambda: None)

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
    monkeypatch.setattr(cli, "_telegram_login_step", lambda: None)

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
    monkeypatch.setattr(cli, "_telegram_login_step", lambda: None)
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
