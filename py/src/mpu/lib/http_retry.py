"""Общий 429-retry для urllib-клиентов (kaiten/miro).

Экспоненциальный backoff с уважением `Retry-After`. Спец-retry `sheet_api`
(quota/5xx/404, httpx) сюда намеренно не сводится — у него другая матрица решений.
"""

import sys
import time
from collections.abc import Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

_MAX_ATTEMPTS = 6
_BACKOFF_CAP = 30.0


def request_with_retry(
    build_request: Callable[[], Request],
    *,
    log_tag: str,
    on_error: Callable[[int, str], Exception],
) -> str:
    """Выполнить запрос с retry на 429; вернуть тело ответа (utf-8 str).

    `build_request` пересоздаёт Request на каждую попытку; `on_error(status, body)`
    строит доменное исключение клиента (KaitenAPIError / MiroAPIError).
    """
    backoff = 1.0
    for _ in range(_MAX_ATTEMPTS):
        req = build_request()
        try:
            with urlopen(req) as r:
                return r.read().decode("utf-8")
        except HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")
            if e.code == 429:  # noqa: PLR2004
                wait = int(e.headers.get("Retry-After", str(int(backoff))))
                print(f"[{log_tag}] 429 rate-limit, sleep {wait}s", file=sys.stderr)
                time.sleep(wait)
                backoff = min(backoff * 2, _BACKOFF_CAP)
                continue
            raise on_error(e.code, err_body) from None
    raise on_error(429, "exhausted retries")
