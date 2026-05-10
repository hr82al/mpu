"""sl-back HTTP API клиент с кешем JWT-токена на 10 мин.

Используется командами `mpuapi-*` (см. `commands/_mpuapi_spec.py`,
`commands/_mpuapi_runtime.py`). Кеш токена — отдельный JSON-файл
`~/.config/mpu/.api-token.json` (не зависит от bootstrap'а sqlite-схемы из
`mpu init`, чтобы `mpuapi-get-token` работал в свежей среде).

Env:
- `BASE_API_URL` — full URL (`https://mp.btlz-api.ru/api`) или path-prefix (`/api`).
- `NEXT_PUBLIC_SERVER_URL` — host, используется если `BASE_API_URL` — это path.
- `TOKEN_EMAIL`, `TOKEN_PASSWORD` — креды для `/auth/login`.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

import httpx

from mpu.lib import env

HttpMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]

TOKEN_TTL_SECONDS = 600  # 10 минут — то же что в SlApi (TS-референс)
DEFAULT_TIMEOUT_SECONDS = 30.0


def _xdg_config_home() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base)


def token_cache_path() -> Path:
    return _xdg_config_home() / "mpu" / ".api-token.json"


class SlApiError(RuntimeError):
    """Ошибка взаимодействия с sl-back. Хранит status и тело ответа (truncated)."""

    def __init__(self, message: str, *, status: int | None = None, body: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[:n] + f"…(+{len(s) - n} bytes)"


def resolve_base_url() -> str:
    """`BASE_API_URL` (full URL) или комбинация `NEXT_PUBLIC_SERVER_URL` + `BASE_API_URL`-path.

    Бросает понятное исключение если ничего не задано.
    """
    api_base = env.get("BASE_API_URL")
    host = env.get("NEXT_PUBLIC_SERVER_URL")
    if api_base and api_base.startswith("http"):
        return api_base.rstrip("/")
    if api_base and host:
        return host.rstrip("/") + "/" + api_base.lstrip("/")
    if host:
        return host.rstrip("/")
    raise SlApiError(
        "sl-back base URL не задан. Поставь BASE_API_URL (full URL) или "
        "NEXT_PUBLIC_SERVER_URL (host) + BASE_API_URL (path) в "
        f"{env.env_path()}"
    )


def resolve_credentials() -> tuple[str, str]:
    """`TOKEN_EMAIL` / `TOKEN_PASSWORD`. Бросает если не заданы."""
    email = env.get("TOKEN_EMAIL")
    password = env.get("TOKEN_PASSWORD")
    missing = [n for n, v in (("TOKEN_EMAIL", email), ("TOKEN_PASSWORD", password)) if not v]
    if missing:
        raise SlApiError(
            f"sl-back credentials missing: {', '.join(missing)}. "
            f"Add to {env.env_path()} or export in shell."
        )
    assert email is not None and password is not None
    return email, password


@dataclass(frozen=True)
class TokenCacheEntry:
    token: str
    expires_at: float

    def is_valid(self, *, now: float | None = None) -> bool:
        return (now if now is not None else time.time()) < self.expires_at


def read_token_cache(path: Path | None = None) -> TokenCacheEntry | None:
    """Прочитать кеш токена. Невалидный файл / просроченный токен → None."""
    p = path if path is not None else token_cache_path()
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    data_dict = cast("dict[str, Any]", data)
    token = data_dict.get("token")
    expires_at = data_dict.get("expires_at")
    if not isinstance(token, str) or not isinstance(expires_at, int | float):
        return None
    entry = TokenCacheEntry(token=token, expires_at=float(expires_at))
    if not entry.is_valid():
        return None
    return entry


def write_token_cache(
    token: str,
    *,
    ttl_seconds: int = TOKEN_TTL_SECONDS,
    path: Path | None = None,
) -> None:
    p = path if path is not None else token_cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"token": token, "expires_at": time.time() + ttl_seconds}
    # Атомарная запись — пишем во временный файл и переименовываем.
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(p)
    # 0600 — токен это секрет. mkdir/replace не гарантируют права, выставляем явно.
    with contextlib.suppress(OSError):
        p.chmod(0o600)


def clear_token_cache(path: Path | None = None) -> bool:
    """Удалить кеш токена. Возвращает True если файл был удалён."""
    p = path if path is not None else token_cache_path()
    try:
        p.unlink()
    except FileNotFoundError:
        return False
    return True


@dataclass
class SlApi:
    """sl-back клиент. Все методы синхронные (httpx.Client).

    Создавать через `SlApi.from_env()` — резолвит base_url и credentials из env.
    Кеш токена живёт в файле, общий для всех вызовов / процессов.
    """

    base_url: str
    email: str
    password: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    cache_path: Path | None = None

    @classmethod
    def from_env(cls) -> SlApi:
        email, password = resolve_credentials()
        return cls(base_url=resolve_base_url(), email=email, password=password)

    def login(self, *, email: str | None = None, password: str | None = None) -> dict[str, Any]:
        """POST /auth/login. Возвращает полный JSON ответа (включая `accessToken`).

        Если `email`/`password` явно переданы — используются они (для override),
        иначе берутся из инстанса (которые из env).
        """
        body = {
            "email": email if email is not None else self.email,
            "password": password if password is not None else self.password,
        }
        return self.request("POST", "/auth/login", body=body, no_auth=True)

    def get_token(self) -> str:
        """Вернуть валидный JWT, обновить кеш если истёк."""
        cached = read_token_cache(self.cache_path)
        if cached is not None:
            return cached.token
        resp = self.login()
        token = resp.get("accessToken")
        if not isinstance(token, str) or not token:
            raise SlApiError(
                "sl-back login: нет accessToken в ответе: "
                + _truncate(json.dumps(resp, ensure_ascii=False), 200)
            )
        write_token_cache(token, path=self.cache_path)
        return token

    def request(
        self,
        method: HttpMethod,
        pathname: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        no_auth: bool = False,
    ) -> Any:
        """Generic HTTP вызов. Добавляет bearer (если не `no_auth`), сериализует JSON.

        Возвращает разпарсенный JSON-ответ (`dict` / `list` / `int` / `str` / `None`).
        Non-2xx → `SlApiError` с `status` и обрезанным `body`.
        Пустой ответ ('') → `None`.
        """
        url = self._build_url(pathname, query)
        headers: dict[str, str] = {}
        if not no_auth:
            headers["authorization"] = f"Bearer {self.get_token()}"
        json_body: Any = body if body is not None else None
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                resp = client.request(method, url, headers=headers, json=json_body)
        except httpx.HTTPError as e:
            raise SlApiError(f"{method} {pathname} failed: transport error: {e}") from e

        text = resp.text
        if resp.status_code >= 400:
            raise SlApiError(
                f"{method} {pathname} failed: HTTP {resp.status_code}",
                status=resp.status_code,
                body=_truncate(text, 500),
            )
        if text == "":
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise SlApiError(
                f"{method} {pathname}: non-JSON response: {_truncate(text, 200)}"
            ) from e

    def _build_url(self, pathname: str, query: Mapping[str, Any] | None) -> str:
        path = pathname if pathname.startswith("/") else "/" + pathname
        url = self.base_url + path
        if not query:
            return url
        # httpx сам умеет params=, но передаём в request() через манипуляцию URL,
        # чтобы наглядно видеть финальный путь в SlApiError.
        from urllib.parse import urlencode

        clean = {k: v for k, v in query.items() if v is not None}
        if not clean:
            return url
        sep = "&" if "?" in url else "?"
        return url + sep + urlencode({k: str(v) for k, v in clean.items()})
