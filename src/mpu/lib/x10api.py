# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""HTTP-клиент 10X (sw-back) admin API.

Тонкий слой над httpx: `login` / `staff_search` / `impersonate` /
`list_workspaces`. **Кэш токенов — НЕ здесь**, а в `lib/x10_session.py`
(sqlite-таблица `x10_sessions`); этот модуль каждый запрос делает под явно
переданным bearer-токеном.

sw-back оборачивает успешные ответы в `{success, message, data}` — методы
возвращают распакованный `data`. Ошибки (non-2xx) → `X10ApiError(status, body)`.

Env:
- `X10_URL` — хост 10X (напр. `https://system10x.btlz-api.ru` или `https://app.system10x.ru`);
  суффикс `/api` добавляется автоматически. Дефолт — `https://app.system10x.ru/api`.
- `X10_LOGIN` / `X10_PASSWORD` — staff-аккаунт 10X для `/auth/login`.
  ВНИМАНИЕ: это ОТДЕЛЬНАЯ от sl-back auth-система (sw-back) — sl-back `TOKEN_*` тут
  НЕ подходят (401). Нужен реальный staff-аккаунт 10X.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode

import httpx

from mpu.lib import env

HttpMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]

DEFAULT_BASE_URL = "https://app.system10x.ru/api"
DEFAULT_TIMEOUT_SECONDS = 30.0


class X10ApiError(RuntimeError):
    """Ошибка взаимодействия с 10X API. Хранит `status` и обрезанное тело ответа."""

    def __init__(self, message: str, *, status: int | None = None, body: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f"…(+{len(s) - n} bytes)"


def resolve_base_url() -> str:
    """`X10_URL` (хост, напр. `https://system10x.btlz-api.ru` или `https://app.system10x.ru`).

    Суффикс `/api` добавляется автоматически. Дефолт — прод `app.system10x.ru/api`.
    """
    raw = (env.get("X10_URL") or env.get("X10_API_URL") or DEFAULT_BASE_URL).rstrip("/")
    return raw if raw.endswith("/api") else raw + "/api"


def resolve_credentials() -> tuple[str, str]:
    """`X10_LOGIN` / `X10_PASSWORD` — staff-аккаунт 10X (sw-back).

    Это ОТДЕЛЬНАЯ от sl-back auth-система — sl-back `TOKEN_*` тут НЕ подходят (401).
    """
    login = env.get("X10_LOGIN")
    password = env.get("X10_PASSWORD")
    missing = [name for name, val in (("X10_LOGIN", login), ("X10_PASSWORD", password)) if not val]
    if missing:
        raise X10ApiError(
            f"10X credentials missing: {', '.join(missing)}. "
            f"Add to {env.env_path()} or export in shell."
        )
    assert login is not None and password is not None
    return login, password


@dataclass
class X10Api:
    """Клиент 10X API. Создавать через `X10Api.from_env()`.

    Токены не кэширует — каждый вызов под явным `token=`. Кэш/refresh — в
    `lib/x10_session.py`.
    """

    base_url: str
    email: str
    password: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    _transport: Any = None  # httpx.MockTransport в тестах

    @classmethod
    def from_env(cls) -> X10Api:
        email, password = resolve_credentials()
        return cls(base_url=resolve_base_url(), email=email, password=password)

    # --- generic ---
    def request(
        self,
        method: HttpMethod,
        pathname: str,
        *,
        token: str | None = None,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
    ) -> Any:
        """HTTP-вызов под bearer `token` (если задан). Non-2xx → `X10ApiError`.

        Возвращает распарсенный JSON (`dict`/`list`/…); пустой ответ → `None`.
        """
        url = self._build_url(pathname, query)
        headers: dict[str, str] = {"accept": "application/json"}
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        kwargs: dict[str, Any] = {"timeout": self.timeout_seconds}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        try:
            with httpx.Client(**kwargs) as client:
                resp = client.request(method, url, headers=headers, json=body)
        except httpx.HTTPError as e:
            raise X10ApiError(f"{method} {pathname}: transport error: {e}") from e

        text = resp.text
        if resp.status_code >= 400:
            raise X10ApiError(
                f"{method} {pathname}: HTTP {resp.status_code}",
                status=resp.status_code,
                body=_truncate(text, 500),
            )
        if text == "":
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise X10ApiError(
                f"{method} {pathname}: non-JSON response: {_truncate(text, 200)}"
            ) from e

    def _unwrap(self, resp: Any, ctx: str) -> Any:
        """Достать `data` из `{success, message, data}`-обёртки sw-back."""
        if not isinstance(resp, dict):
            raise X10ApiError(f"{ctx}: ответ не объект: {_truncate(str(resp), 200)}")
        if "data" not in resp:
            raise X10ApiError(
                f"{ctx}: нет поля data: {_truncate(json.dumps(resp, ensure_ascii=False), 200)}"
            )
        return resp["data"]

    # --- domain ---
    def login(self) -> dict[str, Any]:
        """POST /auth/login → `data` (содержит `access_token`, `user`)."""
        resp = self.request(
            "POST", "/auth/login", body={"email": self.email, "password": self.password}
        )
        return self._unwrap(resp, "10X login")

    def staff_search(self, email: str, *, token: str) -> list[Any]:
        """GET /users/staff/search?query=<email> → `data[]` ({id,email,name,isEmailVerified})."""
        resp = self.request("GET", "/users/staff/search", token=token, query={"query": email})
        data = self._unwrap(resp, "10X staff_search")
        if not isinstance(data, list):
            raise X10ApiError(f"10X staff_search: data не массив: {_truncate(str(data), 200)}")
        return data

    def impersonate(
        self, target_user_id: int, reason: str, *, token: str, workspace_id: int | None = None
    ) -> dict[str, Any]:
        """POST /auth/impersonate → `data` (содержит `access_token`, `user`). Пишет audit-строку."""
        body: dict[str, Any] = {"targetUserId": target_user_id, "reason": reason}
        if workspace_id is not None:
            body["workspaceId"] = workspace_id
        resp = self.request("POST", "/auth/impersonate", token=token, body=body)
        data = self._unwrap(resp, "10X impersonate")
        if not isinstance(data, dict):
            raise X10ApiError(f"10X impersonate: data не объект: {_truncate(str(data), 200)}")
        return data

    def list_workspaces(self, *, token: str) -> list[Any]:
        """GET /workspaces под переданным токеном → `data[]` (полные объекты workspace)."""
        resp = self.request("GET", "/workspaces", token=token)
        data = self._unwrap(resp, "10X list_workspaces")
        if not isinstance(data, list):
            raise X10ApiError(f"10X list_workspaces: data не массив: {_truncate(str(data), 200)}")
        return data

    def _build_url(self, pathname: str, query: Mapping[str, Any] | None) -> str:
        path = pathname if pathname.startswith("/") else "/" + pathname
        url = self.base_url + path
        if not query:
            return url
        clean = {k: str(v) for k, v in query.items() if v is not None}
        if not clean:
            return url
        sep = "&" if "?" in url else "?"
        return url + sep + urlencode(clean)
