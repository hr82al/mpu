"""Тесты `mpu/commands/run_js.py` — user-facing поведение.

Под капотом теперь зовётся `mpu.lib.pssh.pssh_run`; в тестах подменяем именно его,
не вмешиваясь во внутренности транспорта.
"""
# pyright: reportPrivateUsage=false

from collections.abc import Iterator
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import run_js
from mpu.lib import clipboard, portainer_discover, servers, store


def _seed_sqlite(db_path: Path, server_numbers: list[int]) -> None:
    """Bootstrap + добавить mp-sl-N-cli записи в portainer_containers для тестов `--all`.

    После рефакторинга `list_instance_server_numbers()` берёт sl-N исключительно
    из SQLite (наполнение через `mpu init`); тесты должны это поведение зеркалить.
    """
    with store.store(db_path) as conn:
        store.bootstrap(conn)
        items = [
            portainer_discover.DiscoveredContainer(
                portainer_url="https://example:9443",
                endpoint_id=1,
                endpoint_name="local",
                container_id=f"id-{n}",
                container_name=f"mp-sl-{n}-cli",
                server_number=n,
                state="running",
                image="node:22",
            )
            for n in server_numbers
        ]
        portainer_discover.store_discovered(items, conn)


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    p = tmp_path / ".env"
    p.write_text(
        "PG_MY_USER_NAME=alice\n"
        "PORTAINER_API_KEY=ptr_test\n"
        "sl_0='192.168.150.90'\n"
        "sl_1='192.168.150.91'\n"
        "sl_2='192.168.150.92'\n"
        "sl_3='192.168.150.93'\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", p)
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    _seed_sqlite(db_path, [1, 2, 3])
    servers.reset_cache()
    yield p
    servers.reset_cache()


def _noop_clipboard(_t: str) -> bool:
    return True


@pytest.fixture(autouse=True)
def silence_clipboard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_clipboard)
    monkeypatch.setattr(run_js, "copy_to_clipboard", _noop_clipboard)


# ---------- _resolve_servers ----------


def test_resolve_servers_single(env_file: Path) -> None:
    _ = env_file
    assert run_js._resolve_servers("sl-1", False) == [1]


def test_resolve_servers_all_active(env_file: Path) -> None:
    _ = env_file
    assert run_js._resolve_servers(None, True) == [1, 2, 3]


def test_resolve_servers_requires_exactly_one() -> None:
    with pytest.raises(typer.Exit):
        run_js._resolve_servers(None, False)
    with pytest.raises(typer.Exit):
        run_js._resolve_servers("sl-1", True)


def test_resolve_servers_rejects_garbage(env_file: Path) -> None:
    """`foo` не sl-N и в SQLite-кэше нет — `mpu search` вернёт пусто → ResolveError."""
    _ = env_file
    with pytest.raises(typer.Exit):
        run_js._resolve_servers("foo", False)


# ---------- _resolve_js_source ----------


def test_resolve_js_source_positional() -> None:
    assert run_js._resolve_js_source(code="console.log(1)", file=None) == "console.log(1)"


def test_resolve_js_source_file(tmp_path: Path) -> None:
    p = tmp_path / "x.mjs"
    p.write_text("console.log('hi')\n", encoding="utf-8")
    assert run_js._resolve_js_source(code=None, file=p) == "console.log('hi')\n"


def test_resolve_js_source_mutex() -> None:
    with pytest.raises(typer.Exit):
        run_js._resolve_js_source(code="x", file=Path("/dev/null"))


def test_resolve_js_source_empty_rejected() -> None:
    with pytest.raises(typer.Exit):
        run_js._resolve_js_source(code="   \n", file=None)


def test_resolve_js_source_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    import io

    fake_stdin = io.StringIO("console.log(2)")
    monkeypatch.setattr(run_js.sys, "stdin", fake_stdin)
    assert run_js._resolve_js_source(code=None, file=None) == "console.log(2)"


# ---------- _build_dry_run_block ----------


def test_dry_run_single_server() -> None:
    block = run_js._build_dry_run_block([1], "console.log(1)")
    # Без префикса `# server=sl-N` для одного таргета.
    assert "# server=sl-" not in block
    assert "mpu ssh sl-1 -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'" in block
    assert "console.log(1)" in block
    assert block.count("__MPU_RUN_JS_EOF__") == 2


def test_dry_run_multi_server_uses_heredoc() -> None:
    block = run_js._build_dry_run_block([1, 2], "import x;\nawait x();\n")
    assert "# server=sl-1" in block
    assert "# server=sl-2" in block
    assert "mpu ssh sl-1 -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'" in block
    assert "mpu ssh sl-2 -- node --input-type=module - <<'__MPU_RUN_JS_EOF__'" in block
    assert "import x;" in block
    assert "await x();" in block
    # Каждый блок закрыт, итого 4 маркера.
    assert block.count("__MPU_RUN_JS_EOF__") == 4


# ---------- end-to-end CLI ----------


@pytest.fixture
def fake_pssh(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Заменяет pssh_run в run_js: пишет каждый вызов в список и возвращает rc=0."""
    calls: list[dict[str, object]] = []

    def _fake_run(
        *,
        server_number: int,
        cmd: list[str],
        stdin: bytes = b"",
        via: str | None = None,
    ) -> int:
        calls.append({"server_number": server_number, "cmd": list(cmd), "stdin": stdin, "via": via})
        return 0

    monkeypatch.setattr(run_js, "pssh_run", _fake_run)
    return calls


def test_cli_execute_single_server(env_file: Path, fake_pssh: list[dict[str, object]]) -> None:
    _ = env_file
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["sl-1", "console.log(1)"])
    assert result.exit_code == 0, result.output
    assert len(fake_pssh) == 1
    call = fake_pssh[0]
    assert call["server_number"] == 1
    assert call["cmd"] == ["node", "--input-type=module", "-"]
    assert call["stdin"] == b"console.log(1)"
    assert call["via"] is None


def test_cli_execute_fan_out(env_file: Path, fake_pssh: list[dict[str, object]]) -> None:
    """--all + inline code: позиционный repurpose'ится в <code>."""
    _ = env_file
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["--all", "console.log(1)"])
    assert result.exit_code == 0, result.output
    assert [c["server_number"] for c in fake_pssh] == [1, 2, 3]
    assert all(c["stdin"] == b"console.log(1)" for c in fake_pssh)


def test_cli_dry_run_does_not_exec(env_file: Path, fake_pssh: list[dict[str, object]]) -> None:
    _ = env_file
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["sl-1", "console.log(1)", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert fake_pssh == []  # нет exec при dry-run
    assert "mpu ssh sl-1 -- node --input-type=module -" in result.output
    assert "console.log(1)" in result.output


def test_cli_aborts_on_first_failure(env_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """--all → fan-out по [1,2,3]; sl-1 fail → abort до sl-2/sl-3."""
    _ = env_file
    calls: list[int] = []

    def _fake_run(
        *,
        server_number: int,
        cmd: list[str],
        stdin: bytes = b"",
        via: str | None = None,
    ) -> int:
        _ = cmd, stdin, via
        calls.append(server_number)
        return 1 if server_number == 1 else 0

    monkeypatch.setattr(run_js, "pssh_run", _fake_run)
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["--all", "console.log(1)"])
    assert result.exit_code == 1
    assert calls == [1]


def test_cli_via_passthrough(env_file: Path, fake_pssh: list[dict[str, object]]) -> None:
    """--via прокидывается во все вызовы pssh_run."""
    _ = env_file
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["sl-1", "console.log(1)", "--via", "portainer"])
    assert result.exit_code == 0
    assert fake_pssh[0]["via"] == "portainer"


def test_cli_all_with_two_positionals_rejected(
    env_file: Path, fake_pssh: list[dict[str, object]]
) -> None:
    """`mpu run-js --all sl-1 'js'` — два позиционных при --all: ошибка."""
    _ = env_file
    runner = CliRunner()
    result = runner.invoke(run_js.app, ["--all", "sl-1", "console.log(1)"])
    assert result.exit_code == 2
    assert fake_pssh == []


# ---------- list_instance_server_numbers (sanity для run_js fan-out source) ----------


def test_list_instance_server_numbers_excludes_zero(env_file: Path) -> None:
    _ = env_file
    assert servers.list_instance_server_numbers() == [1, 2, 3]
