"""Тесты `mpu/lib/portainer.py` — без сетевых вызовов через httpx.MockTransport."""
# pyright: reportPrivateUsage=false

import io
import json
import socket
import ssl
import struct
import tarfile
from typing import cast

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


def test_demux_docker_frames_splits_stdout_stderr() -> None:
    """3 фрейма (stdout, stderr, stdout) — демультиплексор разводит по callback'ам."""
    buf = bytearray(_frame(1, b"out1\n") + _frame(2, b"err1\n") + _frame(1, b"out2\n"))
    out: list[bytes] = []
    err: list[bytes] = []
    portainer._demux_docker_frames(buf, out.append, err.append)
    assert b"".join(out) == b"out1\nout2\n"
    assert b"".join(err) == b"err1\n"
    assert bytes(buf) == b""


def test_demux_docker_frames_keeps_incomplete_tail() -> None:
    """Неполный хвост остаётся в буфере до следующего вызова — устойчив к разрезам."""
    full = _frame(1, b"hello") + _frame(2, b"world!!")
    out: list[bytes] = []
    err: list[bytes] = []
    buf = bytearray()
    # Скармливаем чанками разной формы — один режет header посередине.
    for chunk in (full[:3], full[3:9], full[9:14], full[14:]):
        buf.extend(chunk)
        portainer._demux_docker_frames(buf, out.append, err.append)
    assert b"".join(out) == b"hello"
    assert b"".join(err) == b"world!!"
    assert bytes(buf) == b""


def test_create_exec_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404, json={"message": "no such container"})

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.create_exec("missing", ["ls"])


# --- root-client helper (для list_endpoints / list_containers) -----------------


def _make_root_client(transport: httpx.MockTransport) -> portainer.Client:
    """Аналог `_make_client`, но подменяет `_root_client()` (base_url до `/api`)."""
    c = portainer.Client(
        base_url="https://example:9443",
        endpoint_id=19,
        api_key="ptr_test",
        verify_tls=False,
    )

    def _make() -> httpx.Client:
        return httpx.Client(
            base_url=f"{c.base_url}/api",
            headers={"X-API-Key": c.api_key},
            transport=transport,
            timeout=httpx.Timeout(5.0),
        )

    c._root_client = _make  # type: ignore[method-assign]
    return c


def _ws_client(base_url: str = "http://example") -> portainer.Client:
    """Клиент для WS-тестов — http по умолчанию (без TLS-обёртки в `_open_ws`)."""
    return portainer.Client(base_url=base_url, endpoint_id=19, api_key="ptr_test")


# --- фейковый сокет для WS-handshake / frame-чтения ----------------------------


class FakeSocket:
    """Duck-type сокета: проигрывает заранее заданные recv-чанки, пишет sendall в `sent`.

    Элемент очереди `recv` может быть `BaseException` — тогда `recv` его бросит
    (моделируем `TimeoutError` в idle-ветке `_read_ws_frames`). Пустая очередь → b"".
    """

    def __init__(self, recv_chunks: list[bytes | BaseException]) -> None:
        self._recv_chunks: list[bytes | BaseException] = list(recv_chunks)
        self.sent: list[bytes] = []
        self.timeout: float | None = None
        self.closed: bool = False
        self.sockopts: list[tuple[int, int, int]] = []

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self.sockopts.append((level, optname, value))

    def sendall(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    def recv(self, _bufsize: int) -> bytes:
        if not self._recv_chunks:
            return b""
        chunk = self._recv_chunks.pop(0)
        if isinstance(chunk, BaseException):
            raise chunk
        return chunk

    def settimeout(self, value: float | None) -> None:
        self.timeout = value

    def close(self) -> None:
        self.closed = True


class FakeSSLContext:
    """Подмена `ssl.create_default_context()` — фиксирует, как `_open_ws` правит проверку TLS."""

    def __init__(self) -> None:
        self.check_hostname: bool = True
        self.verify_mode: ssl.VerifyMode = ssl.CERT_REQUIRED
        self.server_hostname: str | None = None

    def wrap_socket(self, sock: FakeSocket, *, server_hostname: str | None = None) -> FakeSocket:
        self.server_hostname = server_hostname
        return sock


def _as_socket(s: FakeSocket) -> socket.socket:
    # FakeSocket duck-типизирует интерфейс сокета, который использует WS reader/writer;
    # cast нужен, т.к. приватные методы аннотированы `ssl.SSLSocket | socket.socket`.
    return cast(socket.socket, s)


# --- list_endpoints / list_containers (root client) ----------------------------


def test_list_endpoints_filters_non_dict_items() -> None:
    """Список endpoint'ов: мусорные (не-dict) элементы отбрасываются `_filter_dict_list`."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/api/endpoints")
        return httpx.Response(200, json=[{"Id": 1}, "garbage", {"Id": 2}, 42])

    c = _make_root_client(httpx.MockTransport(handler))
    assert c.list_endpoints() == [{"Id": 1}, {"Id": 2}]


def test_list_endpoints_non_list_returns_empty() -> None:
    """JSON-объект вместо массива → пустой список, не падаем."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json={"not": "a list"})

    c = _make_root_client(httpx.MockTransport(handler))
    assert c.list_endpoints() == []


def test_list_endpoints_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(401, json={"message": "unauthorized"})

    c = _make_root_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.list_endpoints()


def test_list_containers_builds_url_and_all_param() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["all"] = request.url.params.get("all")
        return httpx.Response(200, json=[{"Id": "abc"}])

    c = _make_root_client(httpx.MockTransport(handler))
    assert c.list_containers(7) == [{"Id": "abc"}]
    url = captured["url"]
    assert isinstance(url, str)
    assert "/api/endpoints/7/docker/containers/json" in url
    assert captured["all"] == "true"


def test_list_containers_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500)

    c = _make_root_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.list_containers(7)


# --- inspect_container ---------------------------------------------------------


def test_inspect_container_returns_dict() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/containers/cont/json" in str(request.url)
        return httpx.Response(200, json={"Name": "/cont", "State": {"Running": True}})

    c = _make_client(httpx.MockTransport(handler))
    data = c.inspect_container("cont")
    assert data["Name"] == "/cont"
    assert data["State"] == {"Running": True}


def test_inspect_container_non_dict_returns_empty() -> None:
    """Если Docker отдал список вместо объекта — вернуть пустой dict, не упасть."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json=[1, 2, 3])

    c = _make_client(httpx.MockTransport(handler))
    assert c.inspect_container("cont") == {}


def test_inspect_container_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404, json={"message": "no such container"})

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.inspect_container("missing")


# --- container_logs ------------------------------------------------------------


def test_container_logs_demuxes_framed_output() -> None:
    """Docker logs приходят в 8-байтном framing'е → разводим stdout/stderr."""
    raw = _frame(1, b"line1\n") + _frame(2, b"err1\n") + _frame(1, b"line2\n")

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, content=raw)

    c = _make_client(httpx.MockTransport(handler))
    out, err = c.container_logs("cont")
    assert out == b"line1\nline2\n"
    assert err == b"err1\n"


def test_container_logs_tty_stream_goes_to_stdout() -> None:
    """TTY-контейнер: framing'а нет → всё уходит в stdout как есть."""
    raw = b"plain tty output without any framing header"

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, content=raw)

    c = _make_client(httpx.MockTransport(handler))
    out, err = c.container_logs("cont")
    assert out == raw
    assert err == b""


def test_container_logs_builds_params() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, content=b"")

    c = _make_client(httpx.MockTransport(handler))
    c.container_logs(
        "cont",
        tail=50,
        since=1700000000,
        timestamps=True,
        stdout=False,
        stderr=False,
    )
    params = captured["params"]
    assert isinstance(params, dict)
    assert params["tail"] == "50"
    assert params["since"] == "1700000000"
    assert params["timestamps"] == "true"
    assert params["stdout"] == "false"
    assert params["stderr"] == "false"
    assert params["follow"] == "false"


def test_container_logs_omits_since_when_none() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, content=b"")

    c = _make_client(httpx.MockTransport(handler))
    c.container_logs("cont")
    params = captured["params"]
    assert isinstance(params, dict)
    assert "since" not in params
    assert params["stdout"] == "true"
    assert params["stderr"] == "true"


def test_container_logs_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500, text="boom")

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.container_logs("cont")


# --- inspect_exec_exit_code (доп. ветки) ---------------------------------------


def test_inspect_exec_exit_code_zero() -> None:
    """ExitCode=0 — это валидный успех, не None; не путать с null-веткой."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json={"Running": False, "ExitCode": 0})

    c = _make_client(httpx.MockTransport(handler))
    assert c.inspect_exec_exit_code("e") == 0


def test_inspect_exec_exit_code_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404)

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.inspect_exec_exit_code("missing")


# --- create_exec tty flag ------------------------------------------------------


def test_create_exec_tty_true_sets_flag() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, json={"Id": "x"})

    c = _make_client(httpx.MockTransport(handler))
    assert c.create_exec("cont", ["sh"], tty=True) == "x"
    body = captured["json"]
    assert isinstance(body, dict)
    assert body["Tty"] is True


# --- upload_tar error path -----------------------------------------------------


def test_upload_tar_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500)

    c = _make_client(httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        c.upload_tar("cont", "/tmp", {"a.txt": b"x"})


# --- _demux_docker_stream (standalone) -----------------------------------------


def test_demux_docker_stream_tty_passthrough() -> None:
    """Первый байт не 1/2/0 ⇒ TTY-режим ⇒ raw целиком в stdout."""
    raw = b"plain tty output no frames here"
    out, err = portainer._demux_docker_stream(raw)
    assert out == raw
    assert err == b""


def test_demux_docker_stream_empty() -> None:
    assert portainer._demux_docker_stream(b"") == (b"", b"")


def test_demux_docker_stream_skips_stream_type_zero() -> None:
    """stream_type=0 — валидный заголовок, но payload никуда не идёт (consumed, не отдан)."""
    raw = _frame(0, b"ignored") + _frame(1, b"keep")
    out, err = portainer._demux_docker_stream(raw)
    assert out == b"keep"
    assert err == b""


def test_demux_docker_stream_breaks_on_incomplete_frame() -> None:
    """size в заголовке больше доступного хвоста → break, отдаём уже распарсенный префикс."""
    good = _frame(1, b"ok")
    truncated = bytes([1, 0, 0, 0]) + struct.pack(">I", 100) + b"abc"
    out, err = portainer._demux_docker_stream(good + truncated)
    assert out == b"ok"
    assert err == b""


# --- _filter_dict_list (standalone) --------------------------------------------


def test_filter_dict_list_non_list_inputs() -> None:
    assert portainer._filter_dict_list({"a": 1}) == []
    assert portainer._filter_dict_list(None) == []
    assert portainer._filter_dict_list("string") == []


def test_filter_dict_list_drops_non_dicts_and_non_str_keys() -> None:
    data: list[object] = [{"a": 1}, 5, "x", None, {1: "bad", "b": 2}]
    assert portainer._filter_dict_list(data) == [{"a": 1}, {"b": 2}]


# --- _client / _root_client construction (реальные httpx.Client, без сети) ------


def test_client_and_root_client_construction() -> None:
    c = portainer.Client(base_url="https://h:9443", endpoint_id=7, api_key="k")
    with c._client() as inner:
        assert "/api/endpoints/7/docker" in str(inner.base_url)
        assert inner.headers["x-api-key"] == "k"
    with c._root_client() as root:
        assert str(root.base_url).rstrip("/").endswith("/api")
        assert root.headers["x-api-key"] == "k"


# --- start_exec_stream / _open_ws / _read_ws_frames (WS path) -------------------


def test_start_exec_stream_tty_passes_raw_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """tty=True: payload WS-фрейма уходит в on_stdout как есть, stderr пуст."""
    frame = bytes([0x82, 5]) + b"hello"  # binary, unmasked, FIN
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 Switching\r\n\r\n", frame + close])

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream("exec-1", on_stdout=out.append, on_stderr=err.append, tty=True)
    assert b"".join(out) == b"hello"
    assert err == []
    assert fake.closed
    # handshake-запрос содержит путь и X-API-Key
    request = fake.sent[0]
    assert b"GET /api/websocket/exec?id=exec-1&endpointId=19 HTTP/1.1" in request
    assert b"X-API-Key: ptr_test" in request


def test_start_exec_stream_demuxes_non_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    """tty=False: payload WS-фрейма — Docker frames, демультиплексируем по callback'ам."""
    docker = _frame(1, b"out") + _frame(2, b"err")
    ws_frame = bytes([0x82, len(docker)]) + docker
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", ws_frame + close])

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream("e1", on_stdout=out.append, on_stderr=err.append, tty=False)
    assert b"".join(out) == b"out"
    assert b"".join(err) == b"err"
    assert fake.closed


def test_read_ws_frames_ping_and_extended_lengths(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ping → pong; payload-len 126 (16-bit) и 127 (64-bit) ветки в reader'е."""
    ping = bytes([0x89, 2]) + b"pi"
    ext126 = bytes([0x82, 126]) + struct.pack(">H", 3) + b"aaa"
    ext127 = bytes([0x82, 127]) + struct.pack(">Q", 2) + b"bb"
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", ping + ext126 + ext127 + close])

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=err.append, tty=True)
    assert b"".join(out) == b"aaabb"
    # на ping отправлен ровно один pong (opcode 0xA), маскированный, эхо payload'а
    pongs = [s for s in fake.sent if s and (s[0] & 0x0F) == 0xA]
    assert len(pongs) == 1
    pong = pongs[0]
    assert pong[1] & 0x80  # mask bit
    mask = pong[2:6]
    unmasked = bytes(b ^ mask[i % 4] for i, b in enumerate(pong[6:]))
    assert unmasked == b"pi"


def test_read_ws_frames_timeout_sends_ping(monkeypatch: pytest.MonkeyPatch) -> None:
    """recv упёрся в таймаут (idle) → клиент шлёт ping и продолжает чтение."""
    data = bytes([0x82, 3]) + b"abc"
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", TimeoutError(), data + close])

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=err.append, tty=True)
    assert b"".join(out) == b"abc"
    pings = [s for s in fake.sent if s and (s[0] & 0x0F) == 0x9]
    assert len(pings) == 1


def test_open_ws_raises_on_non_101(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSocket([b"HTTP/1.1 403 Forbidden\r\n\r\nnope"])

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    with pytest.raises(httpx.HTTPError, match="handshake failed"):
        c._open_ws("/api/websocket/exec?id=x&endpointId=19")


def test_open_ws_raises_on_early_close(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сервер закрыл соединение до завершения хедеров handshake'а → HTTPError."""
    fake = FakeSocket([])  # recv сразу b""

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    c = _ws_client()
    with pytest.raises(httpx.HTTPError, match="closed before handshake"):
        c._open_ws("/api/websocket/exec?id=x&endpointId=19")


def test_open_ws_tls_disables_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    """https + verify_tls=False → check_hostname=False, verify_mode=CERT_NONE, SNI=host."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x88, 0])])
    ctx = FakeSSLContext()

    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    def _make_ctx() -> FakeSSLContext:
        return ctx

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)
    monkeypatch.setattr(portainer.ssl, "create_default_context", _make_ctx)
    c = _ws_client("https://example:9443")
    out: list[bytes] = []
    err: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=err.append, tty=True)
    assert ctx.check_hostname is False
    assert ctx.verify_mode == ssl.CERT_NONE
    assert ctx.server_hostname == "example"
    assert fake.closed


# --- _send_ws_frame (масштаб длины) --------------------------------------------


def test_send_ws_frame_small_payload_masked() -> None:
    fake = FakeSocket([])
    c = _ws_client()
    c._send_ws_frame(_as_socket(fake), opcode=0x9, payload=b"ab")
    frame = fake.sent[0]
    assert frame[0] == 0x89  # FIN + opcode 0x9
    assert frame[1] == (0x80 | 2)  # mask bit + len 2
    mask = frame[2:6]
    unmasked = bytes(b ^ mask[i % 4] for i, b in enumerate(frame[6:]))
    assert unmasked == b"ab"


def test_send_ws_frame_extended_16bit_length() -> None:
    fake = FakeSocket([])
    c = _ws_client()
    payload = b"x" * 200
    c._send_ws_frame(_as_socket(fake), opcode=0x2, payload=payload)
    frame = fake.sent[0]
    assert frame[1] == (0x80 | 126)
    assert struct.unpack(">H", frame[2:4])[0] == 200
    mask = frame[4:8]
    unmasked = bytes(b ^ mask[i % 4] for i, b in enumerate(frame[8:]))
    assert unmasked == payload


def test_send_ws_frame_extended_64bit_length() -> None:
    fake = FakeSocket([])
    c = _ws_client()
    payload = b"y" * 70000
    c._send_ws_frame(_as_socket(fake), opcode=0x2, payload=payload)
    frame = fake.sent[0]
    assert frame[1] == (0x80 | 127)
    assert struct.unpack(">Q", frame[2:10])[0] == 70000


# --- WS: graceful EOF в разных точках чтения фрейма ------------------------------


def _patch_ws_connect(monkeypatch: pytest.MonkeyPatch, fake: FakeSocket) -> None:
    def _connect(*_args: object, **_kwargs: object) -> FakeSocket:
        return fake

    monkeypatch.setattr(portainer.socket, "create_connection", _connect)


def test_read_ws_frames_eof_before_any_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сервер закрыл сокет сразу после handshake (нет даже close-фрейма) → выходим тихо."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n"])  # дальше recv → b""
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []
    assert fake.closed


def test_read_ws_frames_eof_mid_16bit_length(monkeypatch: pytest.MonkeyPatch) -> None:
    """Оборвался на полпути 16-битного length-поля (plen=126) → graceful return."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x82, 126])])
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []


def test_read_ws_frames_eof_mid_64bit_length(monkeypatch: pytest.MonkeyPatch) -> None:
    """Оборвался на полпути 64-битного length-поля (plen=127) → graceful return."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x82, 127])])
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []


def test_read_ws_frames_eof_mid_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """Заголовок обещает 5 байт payload'а, пришло 2, потом EOF → graceful return."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x82, 5]) + b"ab"])
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []


def test_read_ws_frames_empty_data_frame_skips_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Data-фрейм с пустым payload'ом не зовёт on_data (ветка `if payload`)."""
    empty = bytes([0x82, 0])
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", empty + close])
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []


def test_read_ws_frames_ignores_pong(monkeypatch: pytest.MonkeyPatch) -> None:
    """Входящий pong (opcode 0xA) игнорируется, чтение продолжается до close."""
    pong = bytes([0x8A, 0])
    close = bytes([0x88, 0])
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", pong + close])
    _patch_ws_connect(monkeypatch, fake)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert out == []
    # клиент сам pong не слал (входящий pong — без ответа)
    assert all((s[0] & 0x0F) != 0xA for s in fake.sent if s)


def test_open_ws_skips_missing_keepalive_opts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Если у платформы нет TCP_KEEP* — соответствующие setsockopt просто пропускаются."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x88, 0])])
    _patch_ws_connect(monkeypatch, fake)
    monkeypatch.delattr(portainer.socket, "TCP_KEEPIDLE", raising=False)
    monkeypatch.delattr(portainer.socket, "TCP_KEEPINTVL", raising=False)
    monkeypatch.delattr(portainer.socket, "TCP_KEEPCNT", raising=False)
    c = _ws_client()
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert fake.closed
    # только SO_KEEPALIVE — keep-idle/intvl/cnt пропущены
    assert fake.sockopts == [(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)]


def test_open_ws_tls_keeps_verification_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """https + verify_tls=True → контекст НЕ ослабляется (check_hostname/verify_mode дефолт)."""
    fake = FakeSocket([b"HTTP/1.1 101 ok\r\n\r\n", bytes([0x88, 0])])
    ctx = FakeSSLContext()
    _patch_ws_connect(monkeypatch, fake)

    def _make_ctx() -> FakeSSLContext:
        return ctx

    monkeypatch.setattr(portainer.ssl, "create_default_context", _make_ctx)
    c = portainer.Client(
        base_url="https://example:9443",
        endpoint_id=19,
        api_key="ptr_test",
        verify_tls=True,
    )
    out: list[bytes] = []
    c.start_exec_stream("e", on_stdout=out.append, on_stderr=out.append, tty=True)
    assert ctx.check_hostname is True
    assert ctx.verify_mode == ssl.CERT_REQUIRED


def test_demux_docker_frames_consumes_stream_type_zero() -> None:
    """stream_type=0 — фрейм consumed, но ни в один callback не попадает."""
    buf = bytearray(_frame(0, b"skip") + _frame(1, b"keep"))
    out: list[bytes] = []
    err: list[bytes] = []
    portainer._demux_docker_frames(buf, out.append, err.append)
    assert b"".join(out) == b"keep"
    assert err == []
    assert bytes(buf) == b""
