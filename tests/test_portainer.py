"""Тесты `mpu/lib/portainer.py` — без сетевых вызовов через httpx.MockTransport."""
# pyright: reportPrivateUsage=false

import io
import json
import struct
import tarfile

import httpx
import pytest

from mpu.lib import portainer


def _frame(stream_type: int, payload: bytes) -> bytes:
    """Соберёт Docker multiplex frame: [type][pad pad pad][size BE uint32][payload]."""
    return bytes([stream_type, 0, 0, 0]) + struct.pack(">I", len(payload)) + payload


def _make_client(transport: httpx.MockTransport) -> portainer.Client:
    """Подсовываем MockTransport в _client() через monkeypatch на dataclass.

    Сам Client.create_client делает httpx.Client каждый вызов — оборачиваем через
    замену dataclass-метода на инстансе.
    """
    c = portainer.Client(
        base_url="https://example:9443",
        endpoint_id=19,
        api_key="ptr_test",
        verify_tls=False,
    )

    def _make() -> httpx.Client:
        return httpx.Client(
            base_url=f"{c.base_url}/api/endpoints/{c.endpoint_id}/docker",
            headers={"X-API-Key": c.api_key},
            transport=transport,
            timeout=httpx.Timeout(5.0),
        )

    c._client = _make  # type: ignore[method-assign]
    return c


def test_create_exec_returns_id() -> None:
    received: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        received["url"] = str(request.url)
        received["method"] = request.method
        received["headers"] = dict(request.headers)
        received["json"] = json.loads(request.content)
        return httpx.Response(200, json={"Id": "exec-abc"})

    c = _make_client(httpx.MockTransport(handler))
    exec_id = c.create_exec("mp-sl-11-cli", ["ls", "/app"])
    assert exec_id == "exec-abc"
    url = received["url"]
    assert isinstance(url, str)
    assert url.endswith("/api/endpoints/19/docker/containers/mp-sl-11-cli/exec")
    headers = received["headers"]
    assert isinstance(headers, dict)
    assert headers["x-api-key"] == "ptr_test"
    body = received["json"]
    assert isinstance(body, dict)
    assert body == {
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "Cmd": ["ls", "/app"],
    }


def test_inspect_exec_exit_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(200, json={"Running": False, "ExitCode": 7})

    c = _make_client(httpx.MockTransport(handler))
    assert c.inspect_exec_exit_code("exec-abc") == 7


def test_inspect_exec_null_exit_code_returns_one() -> None:
    """Когда Running=true, ExitCode=null. Возвращаем 1 + warning, не падаем."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"Running": True, "ExitCode": None})

    c = _make_client(httpx.MockTransport(handler))
    assert c.inspect_exec_exit_code("exec-abc") == 1


def test_upload_tar_builds_archive() -> None:
    received: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        received["url"] = str(request.url)
        received["method"] = request.method
        received["body"] = bytes(request.content)
        received["query"] = dict(request.url.params)
        received["content_type"] = request.headers.get("content-type")
        return httpx.Response(200)

    c = _make_client(httpx.MockTransport(handler))
    c.upload_tar("mp-sl-11-cli", "/tmp", {"hello.txt": b"hi"})
    assert received["method"] == "PUT"
    url = received["url"]
    assert isinstance(url, str) and "/containers/mp-sl-11-cli/archive" in url
    query = received["query"]
    assert isinstance(query, dict) and query["path"] == "/tmp"
    assert received["content_type"] == "application/x-tar"

    # Развернём tar и проверим содержимое.
    body = received["body"]
    assert isinstance(body, bytes)
    with tarfile.open(fileobj=io.BytesIO(body), mode="r") as tf:
        names = tf.getnames()
        assert names == ["hello.txt"]
        member = tf.getmember("hello.txt")
        f = tf.extractfile(member)
        assert f is not None
        assert f.read() == b"hi"
        assert member.mode == 0o644


def test_start_exec_stream_demuxes_frames() -> None:
    """Стрим возвращает 3 фрейма: stdout, stderr, stdout. Демультиплексор разводит."""
    body = (
        _frame(1, b"out1\n")
        + _frame(2, b"err1\n")
        + _frame(1, b"out2\n")
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        return httpx.Response(200, content=body)

    c = _make_client(httpx.MockTransport(handler))
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream(
        "exec-abc",
        on_stdout=lambda b: out.append(b),
        on_stderr=lambda b: err.append(b),
    )
    assert b"".join(out) == b"out1\nout2\n"
    assert b"".join(err) == b"err1\n"


def test_start_exec_stream_handles_split_chunks() -> None:
    """Демультиплексор устойчив к разрыву фрейма посередине header'а или payload'а."""
    full: bytes = _frame(1, b"hello") + _frame(2, b"world!!")
    # Чанки разной формы — один из них режет header посередине.
    chunks: list[bytes] = [full[:3], full[3:9], full[9:14], full[14:]]

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, content=iter(chunks))

    c = _make_client(httpx.MockTransport(handler))
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream(
        "exec-abc",
        on_stdout=out.append,
        on_stderr=err.append,
    )
    assert b"".join(out) == b"hello"
    assert b"".join(err) == b"world!!"


def test_create_exec_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404, json={"message": "no such container"})

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.create_exec("missing", ["ls"])
