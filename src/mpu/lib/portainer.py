"""Portainer 2.x HTTP API client — минимальный набор для exec в контейнере.

Поддерживается только non-interactive batch-сценарий: tar upload (опционально для stdin),
exec create / start / inspect. Стрим ответа `/exec/{id}/start` — Docker multiplex framing
(8-byte header per frame). Аутентификация через `X-API-Key`.

Не поддерживается: WebSocket (`/api/websocket/exec`), TTY mode, JWT-логин — намеренно out of scope.
"""

import io
import struct
import tarfile
from collections.abc import Callable
from dataclasses import dataclass

import httpx
import typer


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

    def create_exec(self, container: str, cmd: list[str]) -> str:
        """`POST /containers/{name}/exec` → exec_id."""
        with self._client() as c:
            r = c.post(
                f"/containers/{container}/exec",
                json={
                    "AttachStdout": True,
                    "AttachStderr": True,
                    "Tty": False,
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
    ) -> None:
        """`POST /exec/{id}/start` со стримом тела; демультиплексор Docker framing.

        Frame format (Tty=false):
            byte[0]   stream_type (0=stdin, 1=stdout, 2=stderr)
            byte[1:4] padding
            byte[4:8] payload size, big-endian uint32
            byte[8:8+size] payload

        Стрим читается чанками; буфер копится до тех пор, пока не наберётся header+payload.
        """
        with (
            self._client() as c,
            c.stream(
                "POST",
                f"/exec/{exec_id}/start",
                json={"Detach": False, "Tty": False},
            ) as r,
        ):
            r.raise_for_status()
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf.extend(chunk)
                while len(buf) >= 8:
                    stream_type = buf[0]
                    size = struct.unpack(">I", bytes(buf[4:8]))[0]
                    if len(buf) < 8 + size:
                        break  # ждём ещё байты
                    payload = bytes(buf[8 : 8 + size])
                    del buf[: 8 + size]
                    if stream_type == 1:
                        on_stdout(payload)
                    elif stream_type == 2:
                        on_stderr(payload)
                    # type 0 (stdin) в start-output не приходит; игнорируем.

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
