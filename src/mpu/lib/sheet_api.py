# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Клиент Apps Script webapp для Google Sheets операций.

POST на `WB_PLUS_WEB_APP_URL` с телом `{ action: str, ...payload }`.
Ответ: `{ success: bool, result?: Any, error?: str }`.

Retry-стратегия:
- Сетевая ошибка / 5xx → exponential backoff 250ms..8s, до `max_retries` попыток.
- 429 / "Quota exceeded" → пауза `quota_delay` (default 60s), retry без счётчика.
- 404 → Apps Script иногда отдаёт HTML "Страница не найдена" вместо JSON
  (транзиентный сбой деплоя/редиректа). Фиксированный retry `not_found_retries`
  раз (default 3) с паузой `not_found_delay` (default 10s).
- 2xx + `success: false` → SheetApiError с текстом из `error` (без retry).

Apps Script deployment URL — public (без авторизации), достаточно знать URL.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from mpu.lib import env
from mpu.lib.log import logger

DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_RETRIES = 5
DEFAULT_QUOTA_DELAY_SECONDS = 60.0
DEFAULT_NOT_FOUND_RETRIES = 3
DEFAULT_NOT_FOUND_DELAY_SECONDS = 10.0
_BACKOFF_BASE_MS = 250
_BACKOFF_CAP_MS = 8000


class SheetApiError(RuntimeError):
    """Apps Script вернул `success: false` или non-2xx HTTP."""

    def __init__(
        self,
        message: str,
        *,
        action: str | None = None,
        status: int | None = None,
        body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.action = action
        self.status = status
        self.body = body


def resolve_webapp_url() -> str:
    """`WB_PLUS_WEB_APP_URL` из env. Бросает понятное исключение если не задан."""
    url = env.get("WB_PLUS_WEB_APP_URL")
    if not url:
        raise SheetApiError(
            f"WB_PLUS_WEB_APP_URL не задан. Добавь в {env.env_path()} или export в shell."
        )
    return url


def _is_quota_error(status: int, body: str) -> bool:
    if status == 429:
        return True
    lowered = body.lower()
    return "quota exceeded" in lowered or "too many requests" in lowered


def _backoff_delay_seconds(attempt: int) -> float:
    """Exp backoff с jitter — `attempt` начиная с 0."""
    ms = min(_BACKOFF_BASE_MS * (2**attempt), _BACKOFF_CAP_MS)
    jitter = random.uniform(0, ms * 0.25)
    return (ms + jitter) / 1000.0


@dataclass
class WebappClient:
    """Клиент Apps Script webapp. Создавать через `WebappClient.from_env()`."""

    url: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_MAX_RETRIES
    quota_delay_seconds: float = DEFAULT_QUOTA_DELAY_SECONDS
    not_found_retries: int = DEFAULT_NOT_FOUND_RETRIES
    not_found_delay_seconds: float = DEFAULT_NOT_FOUND_DELAY_SECONDS
    _sleeper: Callable[[float], None] = field(default=time.sleep)
    _transport: Any = field(default=None)  # для тестов — httpx.MockTransport

    @classmethod
    def from_env(cls) -> WebappClient:
        return cls(url=resolve_webapp_url())

    def _make_httpx_client(self) -> httpx.Client:
        # Apps Script отвечает 302 redirect на script.googleusercontent.com — для
        # отображения данных. По умолчанию httpx не следует редиректам, надо явно.
        kwargs: dict[str, Any] = {
            "timeout": self.timeout_seconds,
            "follow_redirects": True,
        }
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.Client(**kwargs)

    def call(self, action: str, **payload: Any) -> dict[str, Any]:
        """POST `{action, **payload}` → возвращает `result` поле ответа."""
        body: dict[str, Any] = {"action": action, **payload}
        last_error: str = ""
        not_found_attempts = 0
        for attempt in range(self.max_retries + 1):
            try:
                with self._make_httpx_client() as client:
                    resp = client.post(
                        self.url,
                        json=body,
                        headers={"content-type": "application/json"},
                    )
            except httpx.HTTPError as e:
                last_error = f"transport: {e}"
                logger.warning(f"sheet_api {action}: {last_error} (attempt {attempt + 1})")
                if attempt >= self.max_retries:
                    raise SheetApiError(
                        f"{action} failed after {attempt + 1} attempts: {last_error}",
                        action=action,
                    ) from e
                self._sleeper(_backoff_delay_seconds(attempt))
                continue

            text = resp.text
            status = resp.status_code

            if _is_quota_error(status, text):
                logger.warning(
                    f"sheet_api {action}: quota exceeded "
                    f"(status={status}), sleeping {self.quota_delay_seconds}s"
                )
                self._sleeper(self.quota_delay_seconds)
                continue

            if status >= 500:
                last_error = f"HTTP {status}: {text[:200]}"
                logger.warning(f"sheet_api {action}: {last_error} (attempt {attempt + 1})")
                if attempt >= self.max_retries:
                    raise SheetApiError(
                        f"{action} failed after {attempt + 1} attempts: {last_error}",
                        action=action,
                        status=status,
                        body=text[:500],
                    )
                self._sleeper(_backoff_delay_seconds(attempt))
                continue

            if status == 404 and not_found_attempts < self.not_found_retries:
                not_found_attempts += 1
                last_error = f"HTTP 404: {text[:200]}"
                logger.warning(
                    f"sheet_api {action}: {last_error} "
                    f"(404 retry {not_found_attempts}/{self.not_found_retries}, "
                    f"sleeping {self.not_found_delay_seconds}s)"
                )
                self._sleeper(self.not_found_delay_seconds)
                continue

            if status >= 400:
                raise SheetApiError(
                    f"{action}: HTTP {status}: {text[:500]}",
                    action=action,
                    status=status,
                    body=text[:500],
                )

            try:
                data = resp.json()
            except ValueError as e:
                raise SheetApiError(
                    f"{action}: non-JSON response: {text[:200]}",
                    action=action,
                    status=status,
                    body=text[:500],
                ) from e

            if not isinstance(data, dict):
                raise SheetApiError(
                    f"{action}: response is not an object: {text[:200]}",
                    action=action,
                    status=status,
                    body=text[:500],
                )

            if not data.get("success"):
                err = str(data.get("error", "unknown error"))
                if "quota" in err.lower():
                    logger.warning(
                        f"sheet_api {action}: quota in body, sleeping {self.quota_delay_seconds}s"
                    )
                    self._sleeper(self.quota_delay_seconds)
                    continue
                raise SheetApiError(
                    f"{action}: {err}",
                    action=action,
                    status=status,
                    body=text[:500],
                )

            result = data.get("result")
            return result if isinstance(result, dict) else {"value": result}

        raise SheetApiError(
            f"{action}: исчерпан лимит попыток ({self.max_retries + 1}). Last error: {last_error}",
            action=action,
        )

    def batch_get(
        self,
        ss_id: str,
        ranges: list[str],
        *,
        value_render: str = "UNFORMATTED_VALUE",
    ) -> dict[str, Any]:
        """`spreadsheets/values/batchGet` — массив value ranges."""
        return self.call(
            "spreadsheets/values/batchGet",
            ssId=ss_id,
            ranges=ranges,
            majorDimension="ROWS",
            valueRenderOption=value_render,
            dateTimeRenderOption="SERIAL_NUMBER",
        )

    def batch_update(
        self,
        ss_id: str,
        data: list[dict[str, Any]],
        *,
        value_input_option: str = "USER_ENTERED",
    ) -> dict[str, Any]:
        """`spreadsheets/values/batchUpdate` — массив `{range, values}`."""
        return self.call(
            "spreadsheets/values/batchUpdate",
            ssId=ss_id,
            requestBody={"valueInputOption": value_input_option, "data": data},
        )

    def batch_update_spreadsheet(
        self,
        ss_id: str,
        requests: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """`spreadsheets/batchUpdate` — структурный (insertDimension/updateCells/…).

        В отличие от `batch_update` (values-only) принимает массив Sheets API
        `requests[]` и применяет их атомарно за один вызов webapp.
        """
        return self.call(
            "spreadsheets/batchUpdate",
            ssId=ss_id,
            requestBody={"requests": requests},
        )

    def get_metadata(self, ss_id: str) -> dict[str, Any]:
        """`spreadsheets/get` — sheets[*].properties."""
        return self.call("spreadsheets/get", ssId=ss_id)
