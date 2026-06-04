"""Тонкий клиент Kaiten REST API (https://<instance>.kaiten.ru/api/latest).

Используется из `mpu kiten`. По образцу `mpu/lib/miro.py` — stdlib urllib + json,
Bearer-auth, retry на 429 (rate-limit Kaiten — 5 req/s). Новых зависимостей нет.

Чистые функции (`parse_card`, `state_label`, `card_url`, `build_cards_query`)
отделены от I/O (`KaitenClient`) и покрыты тестами без сети — сам HTTP-клиент,
как и miro/slapi, тестами не покрывается.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mpu.lib import env

DEFAULT_BASE_URL = "https://btlz.kaiten.ru"
CARDS_PAGE_LIMIT = 100  # Kaiten max amount of cards per response.

_STATE_LABELS = {1: "queued", 2: "in progress", 3: "done"}


@dataclass
class KaitenUser:
    id: int
    full_name: str
    username: str
    email: str


@dataclass
class KaitenCard:
    id: int
    title: str
    state: int | None
    condition: int | None
    due_date: str | None
    board_id: int | None
    url: str


class KaitenAPIError(Exception):
    def __init__(self, method: str, path: str, status: int, body: str):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"kaiten {method} {path} -> {status}: {body[:300]}")


# ── Чистые хелперы (без I/O, тестируемые) ──────────────────────────────────────


def state_label(state: int | None) -> str:
    """Числовой state карточки → человекочитаемая метка. Неизвестное → строка/пусто."""
    if state is None:
        return ""
    return _STATE_LABELS.get(state, str(state))


def card_url(base_url: str, card_id: int) -> str:
    """Web-URL карточки: https://<instance>.kaiten.ru/<id>."""
    return f"{base_url.rstrip('/')}/{card_id}"


def parse_card(raw: dict[str, Any], base_url: str) -> KaitenCard:
    """JSON-карточка из API → KaitenCard. Недостающие поля → None/пусто."""
    card_id = int(raw["id"])
    return KaitenCard(
        id=card_id,
        title=str(raw.get("title") or ""),
        state=raw.get("state"),
        condition=raw.get("condition"),
        due_date=raw.get("due_date"),
        board_id=raw.get("board_id"),
        url=card_url(base_url, card_id),
    )


def build_cards_query(
    *,
    member_ids: str | None = None,
    condition: int | None = None,
    states: str | None = None,
    space_id: int | None = None,
    board_id: int | None = None,
    limit: int = CARDS_PAGE_LIMIT,
    offset: int = 0,
) -> dict[str, str]:
    """Собрать query-dict для GET /cards. None-фильтры не попадают в запрос."""
    query: dict[str, str] = {"limit": str(limit), "offset": str(offset)}
    if member_ids is not None:
        query["member_ids"] = member_ids
    if condition is not None:
        query["condition"] = str(condition)
    if states is not None:
        query["states"] = states
    if space_id is not None:
        query["space_id"] = str(space_id)
    if board_id is not None:
        query["board_id"] = str(board_id)
    return query


# ── I/O-клиент (HTTP, тестами не покрывается — как miro/slapi) ──────────────────


class KaitenClient:
    def __init__(self, token: str, base_url: str = DEFAULT_BASE_URL):
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.api_base = f"{self.base_url}/api/latest"

    @classmethod
    def from_env(cls) -> KaitenClient:
        """Собрать клиент из ~/.config/mpu/.env: KITEN_API_KEY + KITEN_BASE_URL."""
        token = env.require("KITEN_API_KEY")
        base_url = env.get("KITEN_BASE_URL") or DEFAULT_BASE_URL
        return cls(token=token, base_url=base_url)

    def _request(self, method: str, path: str, query: dict[str, str] | None = None) -> Any:
        url = f"{self.api_base}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }

        backoff = 1.0
        for _ in range(6):
            req = Request(url, method=method, headers=headers)
            try:
                with urlopen(req) as r:
                    txt = r.read().decode("utf-8")
                    return json.loads(txt) if txt else None
            except HTTPError as e:
                err_body = e.read().decode("utf-8", "replace")
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After", str(int(backoff))))
                    print(f"[kaiten] 429 rate-limit, sleep {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    backoff = min(backoff * 2, 30)
                    continue
                raise KaitenAPIError(method, path, e.code, err_body) from None
        raise KaitenAPIError(method, path, 429, "exhausted retries")

    def current_user(self) -> KaitenUser:
        """GET /users/current — текущий пользователь по токену."""
        res = self._request("GET", "/users/current")
        return KaitenUser(
            id=int(res["id"]),
            full_name=str(res.get("full_name") or ""),
            username=str(res.get("username") or ""),
            email=str(res.get("email") or ""),
        )

    def list_cards(
        self,
        *,
        member_ids: str | None = None,
        condition: int | None = None,
        states: str | None = None,
        space_id: int | None = None,
        board_id: int | None = None,
    ) -> list[KaitenCard]:
        """GET /cards с фильтрами + пагинацией по offset (limit=100, до пустой страницы)."""
        cards: list[KaitenCard] = []
        offset = 0
        while True:
            query = build_cards_query(
                member_ids=member_ids,
                condition=condition,
                states=states,
                space_id=space_id,
                board_id=board_id,
                limit=CARDS_PAGE_LIMIT,
                offset=offset,
            )
            page = self._request("GET", "/cards", query)
            if not page:
                break
            cards.extend(parse_card(c, self.base_url) for c in page)
            if len(page) < CARDS_PAGE_LIMIT:
                break
            offset += CARDS_PAGE_LIMIT
        return cards
