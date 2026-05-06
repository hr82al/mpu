"""Smoke-тесты на mpu/lib/factories/*.

Каждая фабрика регистрируется в локальный `typer.Typer`, и один метод проверяется
через `CliRunner` — чтобы зафиксировать что путь регистрации не ломает typer-сигнатуру
и что сгенерированный stdout — ожидаемый ssh-/local-вид.
"""

from collections.abc import Iterator

import pytest
import typer
from typer.testing import CliRunner

from mpu.lib import cli_wrap, clipboard, resolver, servers
from mpu.lib.factories import (
    jobs_show,
    loader_by_seller_client,
    loader_by_sid,
    migrations_app,
    migrations_with_dataset,
    migrations_with_type,
)

runner = CliRunner()
SSH_PREFIX = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-2-cli sh -c"
)


def _group_app() -> typer.Typer:
    """typer.Typer + no-op callback — иначе при single-cmd Typer схлопывает в flat-app."""
    app = typer.Typer()

    @app.callback()
    def _root() -> None:  # pyright: ignore[reportUnusedFunction]
        pass

    return app


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def _fake_resolve(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 2, [{"client_id": 2190, "spreadsheet_id": "SS", "server": "sl-2", "title": "ACME"}]

    def _sl_ip(_n: int) -> str | None:
        return "192.168.150.92"

    def _env_value(k: str) -> str | None:
        return "hr82al" if k == "PG_MY_USER_NAME" else None

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(resolver, "resolve_server", _fake_resolve)
    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_copy)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)
    yield


def test_loader_by_sid(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    loader_by_sid.register(
        app=app,
        service="wbLoader",
        methods=[("reports", "wbReports")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["reports", "ACME", "--sid", "abcd"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f'{SSH_PREFIX} "node cli service:wbLoader wbReports --client-id 2190 --sid abcd"\''
    )


def test_loader_by_sid_local(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    loader_by_sid.register(
        app=app,
        service="wbLoader",
        methods=[("cards", "wbCards")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["cards", "ACME", "--sid", "abcd", "--local"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:wbLoader wbCards --client-id 2190 --sid abcd"'
    )


def test_loader_by_seller_client(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    loader_by_seller_client.register(
        app=app,
        service="ozonLoader",
        methods=[("postings-reports", "ozonPostingsReports")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["postings-reports", "ACME", "--seller-client-id", "777"])
    assert result.exit_code == 0, result.output
    inner = (
        "node cli service:ozonLoader ozonPostingsReports --client-id 2190 --seller-client-id 777"
    )
    assert result.stdout.strip() == f'{SSH_PREFIX} "{inner}"\''


def test_migrations_with_type(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    migrations_with_type.register(
        app=app,
        service="clientsMigrations",
        methods=[("latest", "latest")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["latest", "ACME", "--type", "wb"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f'{SSH_PREFIX} "node cli service:clientsMigrations latest --client-id 2190 --type wb"\''
    )


def test_migrations_with_type_with_name_and_forced(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    migrations_with_type.register(
        app=app,
        service="clientsMigrations",
        methods=[("up", "up")],
        command_name="mpu-test",
    )
    result = runner.invoke(
        app, ["up", "ACME", "--type", "wb", "--name", "20260101000000_test", "--forced"]
    )
    assert result.exit_code == 0, result.output
    inner = (
        "node cli service:clientsMigrations up --client-id 2190 --type wb "
        "--name 20260101000000_test --forced"
    )
    assert result.stdout.strip() == f'{SSH_PREFIX} "{inner}"\''


def test_migrations_with_dataset(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    migrations_with_dataset.register(
        app=app,
        service="datasetsMigrations",
        methods=[("latest", "latest")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["latest", "ACME", "--dataset", "wb10xSalesFinReport_v1"])
    assert result.exit_code == 0, result.output
    inner = (
        "node cli service:datasetsMigrations latest "
        "--client-id 2190 --dataset wb10xSalesFinReport_v1"
    )
    assert result.stdout.strip() == f'{SSH_PREFIX} "{inner}"\''


def test_migrations_app(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    migrations_app.register(
        app=app,
        service="appMigrations",
        methods=[("latest", "latest")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["latest", "--server", "sl-2"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (f'{SSH_PREFIX} "node cli service:appMigrations latest"\'')


def test_migrations_app_with_name(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    migrations_app.register(
        app=app,
        service="appMigrations",
        methods=[("up", "up")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["up", "--server", "sl-2", "--name", "20260101000000_test"])
    assert result.exit_code == 0, result.output
    inner = "node cli service:appMigrations up --name 20260101000000_test"
    assert result.stdout.strip() == f'{SSH_PREFIX} "{inner}"\''


def test_jobs_show(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    jobs_show.register(
        app=app,
        service="wbJobs",
        methods=[("show", "showJobs")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["show", "--server", "sl-2"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == f'{SSH_PREFIX} "node cli service:wbJobs showJobs"\''


def test_jobs_show_with_pattern_local(fake_env: None) -> None:
    _ = fake_env
    app = _group_app()
    jobs_show.register(
        app=app,
        service="ozonJobs",
        methods=[("show", "showJobs")],
        command_name="mpu-test",
    )
    result = runner.invoke(app, ["show", "--server", "sl-2", "--pattern", "wbReports", "--local"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ozonJobs showJobs --pattern wbReports"'
    )
