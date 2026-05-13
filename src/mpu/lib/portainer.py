"""Portainer 2.x HTTP API client — минимальный набор для exec в контейнере.

Поддерживается non-interactive batch-сценарий: tar upload (опционально для stdin),
exec create / start / inspect. Аутентификация через `X-API-Key`.

**Стрим exec-вывода идёт через WebSocket** (`/api/websocket/exec`). HTTP-эндпоинт
`/exec/{id}/start` бесполезен для интерактивного наблюдения: Portainer reverse-proxy
буферит ответ Docker'а полностью до завершения exec'а — даже с `Tty=true` и любыми
header'ами пользователь видит весь вывод только в конце. WS-эндпоинт не буферит и
авторизуется тем же `X-API-Key`.

JWT-логин не поддерживается — намеренно out of scope.
"""

import base64
import contextlib
import io
import os
import socket
import ssl
import struct
import tarfile
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass

import httpx
import typer

# Периодичность WS-ping'а с клиента в idle — короче типичного NAT/proxy idle-timeout'а.
_WS_PING_INTERVAL = 30.0


@dataclass
class Client:
    base_url: str  # e.g. "https://192.168.150.12:9443"
    endpoint_id: int  # e.g. 19; для discover может быть 0 (тогда _docker() не использовать)
    api_key: str
    verify_tls: bool = False

    def _client(self) -> httpx.Client:
        """httpx.Client с base_url до `/api/endpoints/{id}/docker` — относительные пути короче."""
        return httpx.Client(
            base_url=f"{self.base_url}/api/endpoints/{self.endpoint_id}/docker",
            headers={"X-API-Key": self.api_key},
            verify=self.verify_tls,
            # Portainer всегда на private endpoint — игнорируем HTTPS_PROXY из окружения,
            # иначе локальный прокси (Privoxy и т.п.) роняет TLS-handshake.
            trust_env=False,
            # connect timeout ограничен; read=None — не падать на длинных exec.
            timeout=httpx.Timeout(30.0, connect=10.0, read=None),
        )

    def _root_client(self) -> httpx.Client:
        """httpx.Client с base_url до `/api` — для endpoint-list без привязки к endpoint_id."""
        return httpx.Client(
            base_url=f"{self.base_url}/api",
            headers={"X-API-Key": self.api_key},
            verify=self.verify_tls,
            trust_env=False,
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    def list_endpoints(self) -> list[dict[str, object]]:
        """`GET /api/endpoints` — список environment'ов."""
        with self._root_client() as c:
            r = c.get("/endpoints")
            r.raise_for_status()
            data = r.json()
        return _filter_dict_list(data)

    def list_containers(self, endpoint_id: int) -> list[dict[str, object]]:
        """`GET /api/endpoints/{id}/docker/containers/json?all=true`."""
        with self._root_client() as c:
            r = c.get(
                f"/endpoints/{endpoint_id}/docker/containers/json",
                params={"all": "true"},
            )
            r.raise_for_status()
            data = r.json()
        return _filter_dict_list(data)

    def inspect_container(self, container: str) -> dict[str, object]:
        """`GET /containers/{name}/json` — full state (включая Health / RestartCount / Pid)."""
        with self._client() as c:
            r = c.get(f"/containers/{container}/json")
            r.raise_for_status()
            data = r.json()
        if not isinstance(data, dict):
            return {}
        out: dict[str, object] = {}
        for k, v in data.items():  # type: ignore[reportUnknownVariableType]
            if isinstance(k, str):
                out[k] = v
        return out

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
        """`GET /containers/{name}/logs?stdout=...&stderr=...&tail=...` → (stdout, stderr).

        Docker отдаёт демультиплексированный поток с тем же 8-байтовым framing'ом, что и
        `/exec/{id}/start` (для `Tty=false`). Парсим тот же буфер; для TTY-контейнеров
        фрейминга нет — детектируем по полному отсутствию валидных заголовков и
        отдаём всё в stdout как есть.
        """
        params: dict[str, str] = {
            "stdout": "true" if stdout else "false",
            "stderr": "true" if stderr else "false",
            "tail": str(tail),
            "follow": "false",
            "timestamps": "true" if timestamps else "false",
        }
        if since is not None:
            params["since"] = str(since)
        with self._client() as c:
            r = c.get(f"/containers/{container}/logs", params=params)
            r.raise_for_status()
            raw = r.content
        return _demux_docker_stream(raw)

    def upload_tar(self, container: str, dest_path: str, files: dict[str, bytes]) -> None:
        """Tar files {name: bytes} и `PUT /containers/{name}/archive?path={dest}`."""
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                tf.addfile(info, io.BytesIO(data))
        with self._client() as c:
            r = c.put(
                f"/containers/{container}/archive",
                params={"path": dest_path},
                content=buf.getvalue(),
                headers={"Content-Type": "application/x-tar"},
            )
            r.raise_for_status()

    def create_exec(self, container: str, cmd: list[str], *, tty: bool = False) -> str:
        """`POST /containers/{name}/exec` → exec_id.

        `tty=True` аллоцирует TTY у Docker'а. Для Node.js это критично: на pipe
        (`tty=False`) `process.stdout` на POSIX асинхронный и батчит мелкие write'ы
        через highWaterMark (16 KB) — пользователь видит бурсты раз в N килобайт.
        На TTY Node переключается на синхронные write'ы — каждый `console.log`
        уходит на провод сразу, стрим виден построчно. Trade-off: stdout/stderr
        смерживаются (Docker отдаёт raw-stream без 8-byte framing'а), но для
        интерактивного `mpup-*` это приемлемо.
        """
        with self._client() as c:
            r = c.post(
                f"/containers/{container}/exec",
                json={
                    "AttachStdout": True,
                    "AttachStderr": True,
                    "Tty": tty,
                    "Cmd": cmd,
                },
            )
            r.raise_for_status()
            return r.json()["Id"]

    def start_exec_stream(
        self,
        exec_id: str,
        *,
        on_stdout: Callable[[bytes], None],
        on_stderr: Callable[[bytes], None],
        tty: bool = False,
    ) -> None:
        """Стрим exec-вывода через `GET /api/websocket/exec?id=<exec>&endpointId=<ep>`.

        Реализуем WS-протокол вручную (RFC 6455) — добавлять `websockets` пакет ради
        одной точки потребления избыточно. Server→client frame'ы не маскированы;
        client→server (pong, close) — маскированы.

        `tty` должен совпадать с тем что передан в `create_exec`:
        - `tty=True`  — Docker даёт raw output, кладём payload как есть в `on_stdout`;
        - `tty=False` — Docker мультиплексирует stdout/stderr 8-байтным header'ом:
            byte[0]   stream_type (1=stdout, 2=stderr)
            byte[1:4] padding
            byte[4:8] payload size, big-endian uint32
            byte[8:8+size] payload
          демультиплексируем и зовём `on_stdout` / `on_stderr` соответственно.
        """
        sock = self._open_ws(f"/api/websocket/exec?id={exec_id}&endpointId={self.endpoint_id}")
        try:
            if tty:
                self._read_ws_frames(sock, on_data=on_stdout)
                return
            demux_buf = bytearray()

            def _on_data(payload: bytes) -> None:
                demux_buf.extend(payload)
                _demux_docker_frames(demux_buf, on_stdout, on_stderr)

            self._read_ws_frames(sock, on_data=_on_data)
        finally:
            with contextlib.suppress(OSError):
                sock.close()

    def _open_ws(self, path: str) -> ssl.SSLSocket | socket.socket:
        """TCP+TLS-сокет с пройденным HTTP/1.1 Upgrade handshake.

        Не используем httpx — он не делает 101-upgrade. Не используем `websockets`
        пакет — он не в whitelist'е зависимостей mpu, а ручной WS-клиент короткий.
        """
        parsed = urllib.parse.urlparse(self.base_url)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        # socket.create_connection напрямую, без HTTPS_PROXY — Portainer на private
        # endpoint, локальный прокси (Privoxy) роняет TLS, как и в httpx-клиенте.
        raw = socket.create_connection((host, port))
        # TCP-keepalive: для длинных exec'ов (`mpup-process` бывает 30+ мин) защищает
        # от тихих обрывов в кернеле. Без явных значений настройки kernel-defaults
        # ловят dead-peer только через ~2 часа idle — слишком долго.
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for opt, val in (
            (getattr(socket, "TCP_KEEPIDLE", None), 60),  # начало проб после 60s idle
            (getattr(socket, "TCP_KEEPINTVL", None), 20),  # 20s между пробами
            (getattr(socket, "TCP_KEEPCNT", None), 3),  # 3 неудачи → close
        ):
            if opt is not None:
                raw.setsockopt(socket.IPPROTO_TCP, opt, val)
        sock: ssl.SSLSocket | socket.socket
        if parsed.scheme == "https":
            ctx = ssl.create_default_context()
            if not self.verify_tls:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(raw, server_hostname=host)
        else:
            sock = raw

        ws_key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {ws_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"X-API-Key: {self.api_key}\r\n\r\n"
        ).encode()
        sock.sendall(request)

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise httpx.HTTPError(f"portainer ws: server closed before handshake (path={path})")
            buf += chunk
        headers, _, leftover = buf.partition(b"\r\n\r\n")
        status_line = headers.split(b"\r\n", 1)[0].decode(errors="replace")
        if "101" not in status_line:
            raise httpx.HTTPError(
                f"portainer ws handshake failed: {status_line}; body={leftover[:200]!r}"
            )
        # Сохраняем приёмный остаток как атрибут — `_read_ws_frames` ниже подберёт.
        sock._mpu_ws_buf = bytearray(leftover)  # type: ignore[attr-defined]
        return sock

    def _read_ws_frames(
        self,
        sock: ssl.SSLSocket | socket.socket,
        *,
        on_data: Callable[[bytes], None],
    ) -> None:
        """Чтение WS-фреймов до Close. Опкоды: 0x1/0x2 — данные, 0x9 — ping, 0x8 — close.

        Каждые `_WS_PING_INTERVAL` секунд idle отправляем pong-инициируемый ping
        (NAT/прокси таблицы могут истечь без активности; некоторые middlebox'ы рубят
        idle WS-сокет через минуты). Reset происходит при любом входящем фрейме —
        ping шлём только если recv реально упёрся в таймаут.
        """
        buf: bytearray = getattr(sock, "_mpu_ws_buf", bytearray())
        sock.settimeout(_WS_PING_INTERVAL)

        def fill(n: int) -> bool:
            while len(buf) < n:
                try:
                    chunk = sock.recv(8192)
                except TimeoutError:
                    # idle — пингуем сервер, чтобы соединение не умерло; продолжаем read
                    self._send_ws_frame(sock, opcode=0x9, payload=b"")
                    continue
                if not chunk:
                    return False
                buf.extend(chunk)
            return True

        while True:
            if not fill(2):
                return
            b1, b2 = buf[0], buf[1]
            opcode = b1 & 0x0F
            plen = b2 & 0x7F
            off = 2
            if plen == 126:
                if not fill(off + 2):
                    return
                plen = struct.unpack(">H", bytes(buf[off : off + 2]))[0]
                off += 2
            elif plen == 127:
                if not fill(off + 8):
                    return
                plen = struct.unpack(">Q", bytes(buf[off : off + 8]))[0]
                off += 8
            if not fill(off + plen):
                return
            payload = bytes(buf[off : off + plen])
            del buf[: off + plen]

            if opcode in (0x0, 0x1, 0x2):  # continuation / text / binary
                if payload:
                    on_data(payload)
            elif opcode == 0x8:  # close
                return
            elif opcode == 0x9:  # ping → pong
                self._send_ws_frame(sock, opcode=0xA, payload=payload)
            # 0xA pong — игнорируем

    def _send_ws_frame(
        self,
        sock: ssl.SSLSocket | socket.socket,
        *,
        opcode: int,
        payload: bytes,
    ) -> None:
        """Маскированный client→server WS-фрейм. RFC 6455 §5.3 требует маски от клиента."""
        frame = bytearray([0x80 | (opcode & 0x0F)])
        plen = len(payload)
        if plen < 126:
            frame.append(0x80 | plen)
        elif plen < 65536:
            frame.append(0x80 | 126)
            frame.extend(struct.pack(">H", plen))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack(">Q", plen))
        mask = os.urandom(4)
        frame.extend(mask)
        frame.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        sock.sendall(bytes(frame))

    def inspect_exec_exit_code(self, exec_id: str) -> int:
        """`GET /exec/{id}/json` → ExitCode. Вызывать только после EOF от start-stream."""
        with self._client() as c:
            r = c.get(f"/exec/{exec_id}/json")
            r.raise_for_status()
            data = r.json()
        code = data.get("ExitCode")
        if code is None:
            typer.echo("portainer: ExitCode is null (Running=true?) — return 1", err=True)
            return 1
        return int(code)


def _demux_docker_frames(
    buf: bytearray,
    on_stdout: Callable[[bytes], None],
    on_stderr: Callable[[bytes], None],
) -> None:
    """Извлечь готовые Docker-фреймы из накапливающего буфера; неполный хвост оставить.

    Frame (Tty=false): byte0 stream_type (1=stdout,2=stderr), byte1:4 padding,
    byte4:8 size BE uint32, byte8:8+size payload. Вызывается каждый раз при поступлении
    нового куска — несклеившиеся хвосты от предыдущих вызовов остаются в `buf` до тех
    пор, пока не наберётся header+payload целиком.
    """
    while len(buf) >= 8:
        stream_type = buf[0]
        size = struct.unpack(">I", bytes(buf[4:8]))[0]
        if len(buf) < 8 + size:
            return
        payload = bytes(buf[8 : 8 + size])
        del buf[: 8 + size]
        if stream_type == 1:
            on_stdout(payload)
        elif stream_type == 2:
            on_stderr(payload)


def _demux_docker_stream(raw: bytes) -> tuple[bytes, bytes]:
    """Демультиплексор Docker logs/exec output (Tty=false framing).

    Frame: byte0 stream_type (1=stdout,2=stderr), byte1:4 padding, byte4:8 size BE,
    byte8:8+size payload. Если первый байт не 1/2 — считаем TTY-режим (поток без
    фрейминга) и возвращаем raw как stdout.
    """
    out_parts: list[bytes] = []
    err_parts: list[bytes] = []
    i = 0
    n = len(raw)
    while i + 8 <= n:
        st = raw[i]
        if st not in (0, 1, 2):
            return raw, b""
        size = struct.unpack(">I", raw[i + 4 : i + 8])[0]
        if i + 8 + size > n:
            break
        payload = raw[i + 8 : i + 8 + size]
        if st == 1:
            out_parts.append(payload)
        elif st == 2:
            err_parts.append(payload)
        i += 8 + size
    return b"".join(out_parts), b"".join(err_parts)


def _filter_dict_list(data: object) -> list[dict[str, object]]:
    """Принять `Any` JSON и вернуть только dict-элементы списка с явным типом."""
    if not isinstance(data, list):
        return []
    out: list[dict[str, object]] = []
    for item in data:  # type: ignore[reportUnknownVariableType]
        if isinstance(item, dict):
            # JSON-ключи всегда str; явное копирование чтобы pyright увидел dict[str, object].
            normalized: dict[str, object] = {}
            for k, v in item.items():  # type: ignore[reportUnknownVariableType]
                if isinstance(k, str):
                    normalized[k] = v
            out.append(normalized)
    return out
