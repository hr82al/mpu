"""Тесты `commands/_logs_portainer.py` — portainer-backend `mpu logs --via portainer`.

Все швы замоканы: `resolve_portainer` подменяется фейком, отдающим `PortainerResolved`
с фейковым `portainer.Client` (программируемые `list_containers` / `container_logs`),
`typer.echo` — рекордером. Двоичный вывод (`sys.stdout.buffer`) ловится `capsysbinary`.
Сеть/Portainer/`time.sleep` не дёргаются.
"""
# тестируем приватные _resolve_container_name / _since_or_exit → нужен доступ к private-символам
# pyright: reportPrivateUsage=false

import time

import httpx
import pytest
import typer

from mpu.commands import _logs_portainer
from mpu.commands._portainer_resolve import PortainerResolved
from mpu.lib import portainer


class _EchoRecorder:
    """Записывает каждый `typer.echo(...)` как `(message, err)`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    def __call__(self, message: str = "", *, err: bool = False, **_kw: object) -> None:
        self.calls.append((message, err))

    @property
    def messages(self) -> list[str]:
        return [m for m, _err in self.calls]


@pytest.fixture
def echo(monkeypatch: pytest.MonkeyPatch) -> _EchoRecorder:
    rec = _EchoRecorder()
    monkeypatch.setattr(typer, "echo", rec)
    return rec


class _FakeClient(portainer.Client):
    """Дублёр `portainer.Client`: программируемые `list_containers` / `container_logs`.

    Наследуется от реального dataclass — остаётся валидным `portainer.Client` для
    `PortainerResolved`, но без сетевого I/O.
    """

    def __init__(
        self,
        *,
        items: list[dict[str, object]] | None = None,
        logs: tuple[bytes, bytes] | BaseException = (b"", b""),
    ) -> None:
        super().__init__(base_url="https://h:9443", endpoint_id=1, api_key="k")
        self._items: list[dict[str, object]] = items if items is not None else []
        self._logs: tuple[bytes, bytes] | BaseException = logs
        self.logs_calls: list[dict[str, object]] = []

    def list_containers(self, endpoint_id: int) -> list[dict[str, object]]:
        _ = endpoint_id
        return self._items

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
        self.logs_calls.append(
            {
                "container": container,
                "tail": tail,
                "since": since,
                "timestamps": timestamps,
                "stdout": stdout,
                "stderr": stderr,
            }
        )
        if isinstance(self._logs, BaseException):
            raise self._logs
        return self._logs


def _item(name: str) -> dict[str, object]:
    """Элемент `containers/json` с одним именем (как у Docker — с ведущим `/`)."""
    return {"Names": [f"/{name}"]}


def _make_pr(client: portainer.Client, *, server_number: int = 2) -> PortainerResolved:
    return PortainerResolved(server_number=server_number, client=client, endpoint_id=1)


def _patch_resolved(
    monkeypatch: pytest.MonkeyPatch, client: portainer.Client, *, server_number: int = 2
) -> PortainerResolved:
    pr = _make_pr(client, server_number=server_number)

    def _fake(*, selector: str, command_name: str) -> PortainerResolved:
        _ = selector, command_name
        return pr

    monkeypatch.setattr(_logs_portainer, "resolve_portainer", _fake)
    return pr


def _run(
    *,
    command_name: str = "mpu logs",
    selector: str = "sl-2",
    container: str = "wb-loader",
    tail: int = 200,
    since: str | None = None,
    timestamps: bool = False,
    no_stdout: bool = False,
    no_stderr: bool = False,
) -> None:
    _logs_portainer.run(
        command_name=command_name,
        selector=selector,
        container=container,
        tail=tail,
        since=since,
        timestamps=timestamps,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
    )


def _fixed_time() -> float:
    return 1000.0


# ── run() — happy path & flags ────────────────────────────────────────────────


def test_run_writes_stdout_and_stderr(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    client = _FakeClient(items=[_item("mp-sl-2-wb-loader")], logs=(b"out-bytes\n", b"err-bytes\n"))
    _patch_resolved(monkeypatch, client)
    _run(container="wb-loader")
    cap = capsysbinary.readouterr()
    assert cap.out == b"out-bytes\n"
    assert cap.err == b"err-bytes\n"
    # Happy path — никаких сообщений об ошибке.
    assert echo.calls == []
    call = client.logs_calls[0]
    assert call["container"] == "mp-sl-2-wb-loader"
    assert call["tail"] == 200
    assert call["since"] is None
    assert call["timestamps"] is False
    assert call["stdout"] is True
    assert call["stderr"] is True


def test_run_no_stdout_suppresses_stdout(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo
    client = _FakeClient(items=[_item("api")], logs=(b"out", b"err"))
    _patch_resolved(monkeypatch, client)
    _run(container="api", no_stdout=True)
    cap = capsysbinary.readouterr()
    assert cap.out == b""
    assert cap.err == b"err"
    assert client.logs_calls[0]["stdout"] is False


def test_run_no_stderr_suppresses_stderr(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo
    client = _FakeClient(items=[_item("api")], logs=(b"out", b"err"))
    _patch_resolved(monkeypatch, client)
    _run(container="api", no_stderr=True)
    cap = capsysbinary.readouterr()
    assert cap.out == b"out"
    assert cap.err == b""
    assert client.logs_calls[0]["stderr"] is False


def test_run_empty_output_writes_nothing(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo
    client = _FakeClient(items=[_item("api")], logs=(b"", b""))
    _patch_resolved(monkeypatch, client)
    _run(container="api")
    cap = capsysbinary.readouterr()
    assert cap.out == b""
    assert cap.err == b""


def test_run_passes_tail_since_timestamps(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo, capsysbinary
    client = _FakeClient(items=[_item("mp-sl-2-wb-loader")], logs=(b"", b""))
    _patch_resolved(monkeypatch, client)
    _run(container="wb-loader", tail=15, since="60", timestamps=True)
    call = client.logs_calls[0]
    assert call["tail"] == 15
    # "60" — абсолютный unix-ts, передаётся как есть.
    assert call["since"] == 60
    assert call["timestamps"] is True


def test_run_exact_match_preferred_over_substring(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo, capsysbinary
    client = _FakeClient(items=[_item("api"), _item("api-worker")], logs=(b"", b""))
    _patch_resolved(monkeypatch, client)
    _run(container="api")
    assert client.logs_calls[0]["container"] == "api"


def test_run_substring_unique_resolves(
    monkeypatch: pytest.MonkeyPatch,
    echo: _EchoRecorder,
    capsysbinary: pytest.CaptureFixture[bytes],
) -> None:
    _ = echo, capsysbinary
    client = _FakeClient(items=[_item("mp-sl-2-internal-api")], logs=(b"", b""))
    _patch_resolved(monkeypatch, client)
    _run(container="internal")
    assert client.logs_calls[0]["container"] == "mp-sl-2-internal-api"


# ── run() — error paths ───────────────────────────────────────────────────────


def test_run_container_not_found_exits_2(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    client = _FakeClient(items=[_item("api")])
    _patch_resolved(monkeypatch, client)
    with pytest.raises(typer.Exit) as ei:
        _run(container="zzz")
    assert ei.value.exit_code == 2
    joined = "\n".join(echo.messages)
    assert "контейнер 'zzz' не найден на sl-2" in joined
    assert "mpu p ps sl-2" in joined
    # container_logs не вызывался.
    assert client.logs_calls == []


def test_run_container_ambiguous_exits_2(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    client = _FakeClient(items=[_item("worker-1"), _item("worker-2")])
    _patch_resolved(monkeypatch, client)
    with pytest.raises(typer.Exit) as ei:
        _run(container="worker")
    assert ei.value.exit_code == 2
    joined = "\n".join(echo.messages)
    assert "несколько контейнеров на sl-2" in joined
    assert "worker-1" in joined
    assert "worker-2" in joined
    assert client.logs_calls == []


def test_run_invalid_since_exits_2(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    client = _FakeClient(items=[_item("api")])
    _patch_resolved(monkeypatch, client)
    with pytest.raises(typer.Exit) as ei:
        _run(container="api", since="not-a-duration")
    assert ei.value.exit_code == 2
    assert any("--since" in m for m in echo.messages)
    # since валидируется после резолва контейнера, но до запроса логов.
    assert client.logs_calls == []


def test_run_http_error_exits_1(monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder) -> None:
    client = _FakeClient(items=[_item("api")], logs=httpx.ConnectError("refused"))
    _patch_resolved(monkeypatch, client)
    with pytest.raises(typer.Exit) as ei:
        _run(container="api")
    assert ei.value.exit_code == 1
    assert any("portainer error: refused" in m for m in echo.messages)


# ── _resolve_container_name() ─────────────────────────────────────────────────


def test_resolve_container_name_exact(echo: _EchoRecorder) -> None:
    _ = echo
    pr = _make_pr(_FakeClient(items=[_item("api"), _item("api-x")]))
    assert _logs_portainer._resolve_container_name(pr, "api", command_name="cmd") == "api"


def test_resolve_container_name_substring_unique(echo: _EchoRecorder) -> None:
    _ = echo
    pr = _make_pr(_FakeClient(items=[_item("mp-sl-1-wb-loader")]), server_number=1)
    name = _logs_portainer._resolve_container_name(pr, "wb-loader", command_name="cmd")
    assert name == "mp-sl-1-wb-loader"


def test_resolve_container_name_not_found_exits_2(echo: _EchoRecorder) -> None:
    pr = _make_pr(_FakeClient(items=[_item("api")]), server_number=3)
    with pytest.raises(typer.Exit) as ei:
        _logs_portainer._resolve_container_name(pr, "nope", command_name="cmd")
    assert ei.value.exit_code == 2
    assert any("не найден на sl-3" in m for m in echo.messages)


def test_resolve_container_name_ambiguous_exits_2(echo: _EchoRecorder) -> None:
    pr = _make_pr(_FakeClient(items=[_item("w-1"), _item("w-2")]))
    with pytest.raises(typer.Exit) as ei:
        _logs_portainer._resolve_container_name(pr, "w", command_name="cmd")
    assert ei.value.exit_code == 2
    assert any("несколько контейнеров" in m for m in echo.messages)


def test_resolve_container_name_ignores_malformed_items(echo: _EchoRecorder) -> None:
    """Item без `Names` / `Names` не список / нестроковый элемент — пропускаются."""
    _ = echo
    items: list[dict[str, object]] = [
        {"Names": "notalist"},
        {"foo": "bar"},
        {"Names": [123, "/good"]},
    ]
    pr = _make_pr(_FakeClient(items=items))
    assert _logs_portainer._resolve_container_name(pr, "good", command_name="cmd") == "good"


# ── _since_or_exit() ──────────────────────────────────────────────────────────


def test_since_or_exit_none_returns_none(echo: _EchoRecorder) -> None:
    _ = echo
    assert _logs_portainer._since_or_exit(None, command_name="cmd") is None


def test_since_or_exit_digit_passthrough(echo: _EchoRecorder) -> None:
    _ = echo
    assert _logs_portainer._since_or_exit("60", command_name="cmd") == 60


def test_since_or_exit_relative_uses_now(
    monkeypatch: pytest.MonkeyPatch, echo: _EchoRecorder
) -> None:
    _ = echo
    monkeypatch.setattr(time, "time", _fixed_time)
    # parse_since("2m") = now(1000) - 120 = 880.
    assert _logs_portainer._since_or_exit("2m", command_name="cmd") == 880


def test_since_or_exit_invalid_exits_2(echo: _EchoRecorder) -> None:
    with pytest.raises(typer.Exit) as ei:
        _logs_portainer._since_or_exit("xyz", command_name="cmd")
    assert ei.value.exit_code == 2
    assert any("--since" in m for m in echo.messages)
