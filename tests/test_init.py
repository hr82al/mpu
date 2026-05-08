"""Тесты `mpu init` (cli.py) + `lib/portainer_discover.py` + servers SQLite-резолва."""
# pyright: reportPrivateUsage=false

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from mpu import cli
from mpu.lib import portainer, portainer_discover, servers, store


@pytest.fixture
def env_with_portainer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    env = tmp_path / ".env"
    env.write_text(
        "PORTAINER_API_KEY=ptr_test\n"
        "PORTAINER_URL=https://example:9443\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", env)
    db = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db)
    servers.reset_cache()
    yield env
    servers.reset_cache()


def _portainer_responses(
    endpoints: list[dict[str, object]],
    containers_by_endpoint: dict[int, list[dict[str, object]]],
) -> httpx.MockTransport:
    """Mock HTTP — `/api/endpoints` и `/api/endpoints/{id}/docker/containers/json`."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/endpoints":
            return httpx.Response(200, json=endpoints)
        # /api/endpoints/{id}/docker/containers/json
        parts = path.strip("/").split("/")
        if (
            len(parts) == 6
            and parts[0] == "api"
            and parts[1] == "endpoints"
            and parts[3] == "docker"
            and parts[4] == "containers"
            and parts[5] == "json"
        ):
            try:
                eid = int(parts[2])
            except ValueError:
                return httpx.Response(400)
            return httpx.Response(200, json=containers_by_endpoint.get(eid, []))
        return httpx.Response(404, json={"path": path})

    return httpx.MockTransport(handler)


def _make_client_with_transport(transport: httpx.MockTransport) -> portainer.Client:
    c = portainer.Client(
        base_url="https://example:9443",
        endpoint_id=0,
        api_key="ptr_test",
        verify_tls=False,
    )

    def _root_make() -> httpx.Client:
        return httpx.Client(
            base_url=f"{c.base_url}/api",
            headers={"X-API-Key": c.api_key},
            transport=transport,
            timeout=httpx.Timeout(5.0),
        )

    c._root_client = _root_make  # type: ignore[method-assign]
    return c


# ---------- discover ----------


def test_discover_picks_mp_sl_n_cli_and_others() -> None:
    endpoints: list[dict[str, object]] = [
        {"Id": 1, "Name": "local"},
        {"Id": 19, "Name": "wb-prod"},
    ]
    containers_by_ep: dict[int, list[dict[str, object]]] = {
        1: [
            {"Id": "abc", "Names": ["/mp-sl-1-cli"], "State": "running", "Image": "node:22"},
            {"Id": "def", "Names": ["/postgres"], "State": "running", "Image": "postgres:15"},
        ],
        19: [
            {"Id": "ghi", "Names": ["/mp-sl-11-cli"], "State": "running", "Image": "node:22"},
            {"Id": "jkl", "Names": ["/random-service"], "State": "exited", "Image": "alpine"},
        ],
    }
    transport = _portainer_responses(endpoints, containers_by_ep)
    client = _make_client_with_transport(transport)
    items = portainer_discover.discover(client)
    assert len(items) == 4

    # Маппинг server_number есть только у mp-sl-N-cli.
    by_name = {i.container_name: i for i in items}
    assert by_name["mp-sl-1-cli"].server_number == 1
    assert by_name["mp-sl-11-cli"].server_number == 11
    assert by_name["postgres"].server_number is None
    assert by_name["random-service"].server_number is None


def test_discover_skips_endpoint_on_failure() -> None:
    """Если одна endpoint упала — discover не падает целиком, идёт дальше."""
    endpoints = [{"Id": 1, "Name": "ok"}, {"Id": 2, "Name": "broken"}]

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/endpoints":
            return httpx.Response(200, json=endpoints)
        if "/endpoints/1/" in path:
            return httpx.Response(
                200,
                json=[{"Id": "x", "Names": ["/mp-sl-5-cli"], "State": "running", "Image": "n"}],
            )
        return httpx.Response(500, json={"err": "broken"})

    client = _make_client_with_transport(httpx.MockTransport(handler))
    items = portainer_discover.discover(client)
    assert len(items) == 1
    assert items[0].server_number == 5


# ---------- store_discovered ----------


def test_store_discovered_writes_and_upserts(tmp_path: Path) -> None:
    db = tmp_path / "mpu.db"
    with store.store(db) as conn:
        store.bootstrap(conn)
        items = [
            portainer_discover.DiscoveredContainer(
                portainer_url="https://example:9443",
                endpoint_id=1,
                endpoint_name="local",
                container_id="abc",
                container_name="mp-sl-1-cli",
                server_number=1,
                state="running",
                image="node:22",
            ),
            portainer_discover.DiscoveredContainer(
                portainer_url="https://example:9443",
                endpoint_id=1,
                endpoint_name="local",
                container_id="def",
                container_name="postgres",
                server_number=None,
                state="running",
                image="postgres:15",
            ),
        ]
        portainer_discover.store_discovered(items, conn)
        rows = conn.execute(
            "SELECT container_name, server_number FROM portainer_containers ORDER BY container_id"
        ).fetchall()
        assert {(r["container_name"], r["server_number"]) for r in rows} == {
            ("mp-sl-1-cli", 1),
            ("postgres", None),
        }

        # Upsert: повторный запуск с обновлённым state не плодит дубликаты.
        items[0] = portainer_discover.DiscoveredContainer(
            portainer_url="https://example:9443",
            endpoint_id=1,
            endpoint_name="local",
            container_id="abc",
            container_name="mp-sl-1-cli",
            server_number=1,
            state="exited",
            image="node:22",
        )
        portainer_discover.store_discovered([items[0]], conn)
        states = conn.execute(
            "SELECT state FROM portainer_containers WHERE container_id='abc'"
        ).fetchall()
        assert len(states) == 1
        assert states[0]["state"] == "exited"


# ---------- servers.portainer_target lookup chain ----------


def test_portainer_target_reads_sqlite_first(
    env_with_portainer: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_with_portainer
    db = store.DB_PATH
    with store.store(db) as conn:
        store.bootstrap(conn)
        portainer_discover.store_discovered(
            [
                portainer_discover.DiscoveredContainer(
                    portainer_url="https://example:9443",
                    endpoint_id=42,
                    endpoint_name="wb",
                    container_id="abc",
                    container_name="mp-sl-7-cli",
                    server_number=7,
                    state="running",
                    image="node:22",
                ),
            ],
            conn,
        )
    servers.reset_cache()
    target = servers.portainer_target(7)
    assert target == ("https://example:9443", 42)


def test_portainer_target_falls_back_to_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Если в SQLite нет sl-N, а в .env есть legacy `sl_N_portainer` — используем его."""
    env = tmp_path / ".env"
    env.write_text(
        "PORTAINER_API_KEY=x\n"
        "sl_99_portainer=https://legacy:9443/77\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", env)
    db = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db)
    # SQLite без таблиц — _portainer_db_map должен вернуть {} без ошибки.
    servers.reset_cache()
    assert servers.portainer_target(99) == ("https://legacy:9443", 77)


def test_list_instance_server_numbers_only_from_sqlite(
    env_with_portainer: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Источник истины — SQLite. ssh-only из `sl_N` и legacy `sl_N_portainer` игнорируются."""
    env = env_with_portainer
    env.write_text(
        env.read_text()
        + "sl_2='10.0.0.2'\n"  # ssh-only — НЕ должен попасть в --all
        + "sl_99_portainer=https://legacy:9443/77\n",  # legacy env — тоже НЕ должен
        encoding="utf-8",
    )
    monkeypatch.setattr(servers, "ENV_PATH", env)
    servers.reset_cache()

    db = store.DB_PATH
    with store.store(db) as conn:
        store.bootstrap(conn)
        portainer_discover.store_discovered(
            [
                portainer_discover.DiscoveredContainer(
                    portainer_url="https://example:9443",
                    endpoint_id=1,
                    endpoint_name="",
                    container_id="x",
                    container_name="mp-sl-7-cli",
                    server_number=7,
                    state="running",
                    image="",
                ),
                portainer_discover.DiscoveredContainer(
                    portainer_url="https://example:9443",
                    endpoint_id=1,
                    endpoint_name="",
                    container_id="y",
                    container_name="postgres",
                    server_number=None,  # non-mp-sl-N-cli — server_number IS NULL
                    state="running",
                    image="",
                ),
            ],
            conn,
        )
    servers.reset_cache()
    # Только sl-7 — единственный mp-sl-N-cli в SQLite. Env-источники намеренно не учитываются.
    assert servers.list_instance_server_numbers() == [7]


# ---------- mpu init CLI ----------


def test_mpu_init_command_writes_to_sqlite(
    env_with_portainer: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_with_portainer
    endpoints: list[dict[str, object]] = [{"Id": 1, "Name": "local"}]
    containers: dict[int, list[dict[str, object]]] = {
        1: [
            {"Id": "abc", "Names": ["/mp-sl-1-cli"], "State": "running", "Image": "node:22"},
            {"Id": "def", "Names": ["/redis"], "State": "running", "Image": "redis:7"},
        ],
    }
    transport = _portainer_responses(endpoints, containers)

    def fake_make(portainer_url_override: str | None = None) -> portainer.Client:
        _ = portainer_url_override
        return _make_client_with_transport(transport)

    monkeypatch.setattr(portainer_discover, "make_client_from_env", fake_make)
    runner = CliRunner()
    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert "sl-1: mp-sl-1-cli" in result.output
    assert "прочих контейнеров: 1" in result.output

    with store.store(store.DB_PATH) as conn:
        rows = conn.execute(
            "SELECT container_name, server_number FROM portainer_containers"
        ).fetchall()
        assert {(r["container_name"], r["server_number"]) for r in rows} == {
            ("mp-sl-1-cli", 1),
            ("redis", None),
        }


def test_mpu_init_dry_run_does_not_write(
    env_with_portainer: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_with_portainer
    endpoints: list[dict[str, object]] = [{"Id": 1, "Name": "local"}]
    containers: dict[int, list[dict[str, object]]] = {
        1: [{"Id": "x", "Names": ["/mp-sl-9-cli"], "State": "running", "Image": ""}],
    }
    transport = _portainer_responses(endpoints, containers)

    def fake_make(portainer_url_override: str | None = None) -> portainer.Client:
        _ = portainer_url_override
        return _make_client_with_transport(transport)

    monkeypatch.setattr(portainer_discover, "make_client_from_env", fake_make)
    runner = CliRunner()
    result = runner.invoke(cli.app, ["init", "--dry-run"])
    assert result.exit_code == 0
    # Bootstrap всё равно создаёт схему, но container записан НЕ должен быть.
    with store.store(store.DB_PATH) as conn:
        n = conn.execute("SELECT COUNT(*) FROM portainer_containers").fetchone()[0]
        assert n == 0


def test_mpu_init_reset_clears_old_rows(
    env_with_portainer: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = env_with_portainer
    # Заранее положим что-то в таблицу — должно быть удалено флагом --reset.
    db = store.DB_PATH
    with store.store(db) as conn:
        store.bootstrap(conn)
        conn.execute(
            "INSERT INTO portainer_containers "
            "(portainer_url, endpoint_id, endpoint_name, container_id, container_name, "
            "server_number, state, image, discovered_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("https://stale:9443", 99, "", "stale-id", "stale-cli", 99, "exited", "", 1),
        )
        conn.commit()

    endpoints: list[dict[str, object]] = [{"Id": 1, "Name": "local"}]
    containers: dict[int, list[dict[str, object]]] = {
        1: [{"Id": "fresh", "Names": ["/mp-sl-1-cli"], "State": "running", "Image": ""}],
    }
    transport = _portainer_responses(endpoints, containers)

    def fake_make(portainer_url_override: str | None = None) -> portainer.Client:
        _ = portainer_url_override
        return _make_client_with_transport(transport)

    monkeypatch.setattr(portainer_discover, "make_client_from_env", fake_make)
    runner = CliRunner()
    result = runner.invoke(cli.app, ["init", "--reset"])
    assert result.exit_code == 0
    with store.store(db) as conn:
        rows = conn.execute("SELECT container_name FROM portainer_containers").fetchall()
        assert [r["container_name"] for r in rows] == ["mp-sl-1-cli"]


def test_mpu_init_no_api_key_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("PORTAINER_URL=https://example:9443\n", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", env)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    runner = CliRunner()
    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 2
    assert "PORTAINER_API_KEY" in result.output


def test_mpu_init_no_url_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("PORTAINER_API_KEY=x\n", encoding="utf-8")
    monkeypatch.setattr(servers, "ENV_PATH", env)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "mpu.db")
    servers.reset_cache()
    runner = CliRunner()
    result = runner.invoke(cli.app, ["init"])
    assert result.exit_code == 2
    assert "PORTAINER_URL" in result.output


# ---------- json import (smoke на handler URL parser) ----------


def test_json_smoke() -> None:
    """Pure smoke; httpx Response с json= это json.loads-совместимо."""
    assert json.loads("[]") == []
