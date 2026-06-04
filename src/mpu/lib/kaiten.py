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
from typing import Any, cast
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
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
    updated: str | None
    board_id: int | None
    column_id: int | None
    url: str


@dataclass
class KaitenSpace:
    id: int
    title: str
    archived: bool


@dataclass
class KaitenBoard:
    id: int
    space_id: int
    title: str


@dataclass
class KaitenLane:
    id: int
    board_id: int
    title: str


@dataclass
class KaitenColumn:
    id: int
    board_id: int
    title: str


@dataclass
class KaitenFile:
    id: int
    url: str
    name: str
    mime_type: str | None
    comment_id: int | None  # None = card-level, иначе вложение комментария
    card_cover: bool


@dataclass
class KaitenMember:
    id: int
    full_name: str
    email: str
    username: str


@dataclass
class KaitenComment:
    id: int
    text: str  # GFM markdown
    author_name: str
    created: str | None


@dataclass
class KaitenCustomProperty:
    id: int
    name: str
    type: str | None


@dataclass
class KaitenCardDetail:
    id: int
    key: str | None
    title: str
    state: int | None
    condition: int | None
    due_date: str | None
    board_id: int | None
    board_title: str | None
    column_id: int | None
    column_title: str | None
    lane_title: str | None
    size_text: str | None
    created: str | None
    updated: str | None
    type_name: str | None
    description: str | None  # GFM markdown
    owner: KaitenMember | None
    url: str
    tags: list[str]
    members: list[KaitenMember]
    files: list[KaitenFile]
    properties: dict[str, str]


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
        updated=raw.get("updated"),
        board_id=raw.get("board_id"),
        column_id=raw.get("column_id"),
        url=card_url(base_url, card_id),
    )


def build_cards_query(
    *,
    member_ids: str | None = None,
    condition: int | None = None,
    states: str | None = None,
    space_id: int | None = None,
    board_id: int | None = None,
    lane_id: int | None = None,
    column_id: int | None = None,
    updated_after: str | None = None,
    updated_before: str | None = None,
    limit: int = CARDS_PAGE_LIMIT,
    offset: int = 0,
) -> dict[str, str]:
    """Собрать query-dict для GET /cards. None-фильтры не попадают в запрос.

    NB: фильтр дорожки в API — `lane_id` (единственное число), в отличие от
    `member_ids` (множественное). Плюральный `lane_ids` сервером игнорируется.
    Колонка — `column_id`.

    `updated_after` / `updated_before` — окно активности (последнее обновление
    карточки), формат ISO 8601 (`YYYY-MM-DDThh:mm:ssZ`). Сервер фильтрует по полю
    `updated`; неизвестные имена он молча игнорирует, поэтому имена точные.
    """
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
    if lane_id is not None:
        query["lane_id"] = str(lane_id)
    if column_id is not None:
        query["column_id"] = str(column_id)
    if updated_after is not None:
        query["updated_after"] = updated_after
    if updated_before is not None:
        query["updated_before"] = updated_before
    return query


def parse_space(raw: dict[str, Any]) -> KaitenSpace:
    """JSON-space из GET /spaces → KaitenSpace. `boards[]` извлекается отдельно."""
    return KaitenSpace(
        id=int(raw["id"]),
        title=str(raw.get("title") or ""),
        archived=bool(raw.get("archived")),
    )


def parse_lane(raw: dict[str, Any]) -> KaitenLane:
    """JSON-lane из GET /boards/{id}/lanes → KaitenLane."""
    return KaitenLane(
        id=int(raw["id"]),
        board_id=int(raw["board_id"]),
        title=str(raw.get("title") or ""),
    )


def parse_column(raw: dict[str, Any]) -> KaitenColumn:
    """JSON-column из GET /boards/{id}/columns → KaitenColumn. `card.column_id` → column.id."""
    return KaitenColumn(
        id=int(raw["id"]),
        board_id=int(raw["board_id"]),
        title=str(raw.get("title") or ""),
    )


def parse_boards_of_space(raw: dict[str, Any]) -> list[KaitenBoard]:
    """Встроенный в space `boards[]` → list[KaitenBoard]. Нет ключа / не список → []."""
    boards = raw.get("boards")
    if not isinstance(boards, list):
        return []
    parsed: list[KaitenBoard] = []
    for entry in cast("list[object]", boards):
        if not isinstance(entry, dict):
            continue
        b = cast("dict[str, Any]", entry)
        parsed.append(
            KaitenBoard(
                id=int(b["id"]),
                space_id=int(b.get("space_id") or raw["id"]),
                title=str(b.get("title") or ""),
            )
        )
    return parsed


def parse_card_ref(ref: str) -> int:
    """Селектор → id карточки. Принимает голый id, короткий URL btlz.kaiten.ru/<id>
    или глубокий URL .../boards/card/<id>?filter=…

    id — **последний** полностью числовой сегмент пути (так `.../space/286794/boards/
    card/65634936` резолвится в карточку 65634936, а не в space 286794); query/fragment
    отбрасываются `urlparse`. Нет числового сегмента → ValueError.
    """
    s = ref.strip()
    if s.isdigit():
        return int(s)
    path = urlparse(s).path
    segments = [seg for seg in path.split("/") if seg.isdigit()]
    if not segments:
        raise ValueError(f"не удалось извлечь id карточки из {ref!r}")
    return int(segments[-1])


def _member_name(raw: dict[str, Any] | None) -> str:
    """full_name автора из вложенного `author`/`owner` объекта; пусто, если нет."""
    if not isinstance(raw, dict):
        return ""
    return str(raw.get("full_name") or raw.get("username") or "")


def parse_member(raw: dict[str, Any]) -> KaitenMember:
    """JSON-участник (members[]/owner) → KaitenMember. Недостающие поля → пусто."""
    return KaitenMember(
        id=int(raw["id"]),
        full_name=str(raw.get("full_name") or ""),
        email=str(raw.get("email") or ""),
        username=str(raw.get("username") or ""),
    )


def parse_file(raw: dict[str, Any]) -> KaitenFile:
    """JSON-файл (files[]) → KaitenFile. `comment_id=null` ⇒ вложение карточки."""
    return KaitenFile(
        id=int(raw["id"]),
        url=str(raw.get("url") or ""),
        name=str(raw.get("name") or ""),
        mime_type=raw.get("mime_type"),
        comment_id=raw.get("comment_id"),
        card_cover=bool(raw.get("card_cover")),
    )


def parse_comment(raw: dict[str, Any]) -> KaitenComment:
    """JSON-комментарий (GET /cards/{id}/comments) → KaitenComment. `text` — GFM markdown."""
    return KaitenComment(
        id=int(raw["id"]),
        text=str(raw.get("text") or ""),
        author_name=_member_name(raw.get("author")),
        created=raw.get("created"),
    )


def parse_custom_property(raw: dict[str, Any]) -> KaitenCustomProperty:
    """JSON-определение кастомного поля (GET /company/custom-properties) → KaitenCustomProperty."""
    return KaitenCustomProperty(
        id=int(raw["id"]),
        name=str(raw.get("name") or ""),
        type=raw.get("type"),
    )


def _nested_title(raw: dict[str, Any], key: str) -> str | None:
    """`title` вложенного объекта (`board`/`column`/`lane`); None, если нет."""
    obj = raw.get(key)
    if isinstance(obj, dict):
        title = cast("dict[str, Any]", obj).get("title")
        return str(title) if title is not None else None
    return None


def _string_properties(raw: dict[str, Any]) -> dict[str, str]:
    """`properties` карточки → только строковые значения (ключи id_NNN). Не-строки
    (select/catalog → id/массив) приводим к str, чтобы не терять поле."""
    props = raw.get("properties")
    if not isinstance(props, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in cast("dict[str, Any]", props).items():
        if value is None:
            continue
        out[str(key)] = value if isinstance(value, str) else str(value)
    return out


def _dict_items(raw_value: object) -> list[dict[str, Any]]:
    """Значение API → список dict-элементов (не список / не-dict элементы отбрасываются).

    Зеркало `parse_boards_of_space`: cast к list[object] + isinstance-narrow, чтобы
    строгий pyright видел реальный тип, а не Unknown.
    """
    if not isinstance(raw_value, list):
        return []
    items: list[dict[str, Any]] = []
    for entry in cast("list[object]", raw_value):
        if isinstance(entry, dict):
            items.append(cast("dict[str, Any]", entry))
    return items


def _tag_names(raw_value: object) -> list[str]:
    """`tags[].name` → list[str]."""
    return [str(t.get("name") or "") for t in _dict_items(raw_value)]


def parse_card_detail(raw: dict[str, Any], base_url: str) -> KaitenCardDetail:
    """Полный JSON карточки (GET /cards/{id}) → KaitenCardDetail. Недостающее → None/[]."""
    card_id = int(raw["id"])
    owner = raw.get("owner")
    return KaitenCardDetail(
        id=card_id,
        key=raw.get("key"),
        title=str(raw.get("title") or ""),
        state=raw.get("state"),
        condition=raw.get("condition"),
        due_date=raw.get("due_date"),
        board_id=raw.get("board_id"),
        board_title=_nested_title(raw, "board"),
        column_id=raw.get("column_id"),
        column_title=_nested_title(raw, "column"),
        lane_title=_nested_title(raw, "lane"),
        size_text=raw.get("size_text"),
        created=raw.get("created"),
        updated=raw.get("updated"),
        type_name=_nested_title(raw, "type"),
        description=raw.get("description"),
        owner=parse_member(cast("dict[str, Any]", owner)) if isinstance(owner, dict) else None,
        url=card_url(base_url, card_id),
        tags=_tag_names(raw.get("tags")),
        members=[parse_member(m) for m in _dict_items(raw.get("members"))],
        files=[parse_file(f) for f in _dict_items(raw.get("files"))],
        properties=_string_properties(raw),
    )


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
        lane_id: int | None = None,
        column_id: int | None = None,
        updated_after: str | None = None,
        updated_before: str | None = None,
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
                lane_id=lane_id,
                column_id=column_id,
                updated_after=updated_after,
                updated_before=updated_before,
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

    def list_spaces(self) -> tuple[list[KaitenSpace], list[KaitenBoard]]:
        """GET /spaces — справочник. Boards встроены в каждый space, отдаём их плоско.

        Глобального GET /boards у Kaiten нет (405), поэтому boards собираются из
        вложенного `boards[]` каждого space за один запрос.
        """
        res = self._request("GET", "/spaces")
        spaces: list[KaitenSpace] = []
        boards: list[KaitenBoard] = []
        if not res:
            return spaces, boards
        for raw in cast("list[dict[str, Any]]", res):
            spaces.append(parse_space(raw))
            boards.extend(parse_boards_of_space(raw))
        return spaces, boards

    def list_lanes(self, board_ids: list[int]) -> list[KaitenLane]:
        """GET /boards/{id}/lanes для каждой доски, плоский список.

        Best-effort: доска, которая отдала ошибку (нет доступа и т.п.), пропускается,
        чтобы один сбой не валил весь обход. Глобального списка дорожек у Kaiten нет.
        """
        lanes: list[KaitenLane] = []
        for board_id in board_ids:
            try:
                res = self._request("GET", f"/boards/{board_id}/lanes")
            except KaitenAPIError:
                continue
            if not res:
                continue
            for raw in cast("list[dict[str, Any]]", res):
                lanes.append(parse_lane(raw))
        return lanes

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        """GET /boards/{id}/columns по доскам, плоский список. Best-effort (как list_lanes)."""
        columns: list[KaitenColumn] = []
        for board_id in board_ids:
            try:
                res = self._request("GET", f"/boards/{board_id}/columns")
            except KaitenAPIError:
                continue
            if not res:
                continue
            for raw in cast("list[dict[str, Any]]", res):
                columns.append(parse_column(raw))
        return columns

    def get_card(self, card_id: int) -> KaitenCardDetail:
        """GET /cards/{id} — полная карточка (описание, файлы, участники, properties)."""
        res = self._request("GET", f"/cards/{card_id}")
        return parse_card_detail(res, self.base_url)

    def get_comments(self, card_id: int) -> list[KaitenComment]:
        """GET /cards/{id}/comments — комментарии (хронологически). `text` — GFM markdown."""
        res = self._request("GET", f"/cards/{card_id}/comments")
        if not res:
            return []
        return [parse_comment(c) for c in cast("list[dict[str, Any]]", res)]

    def list_custom_properties(self) -> list[KaitenCustomProperty]:
        """GET /company/custom-properties — определения кастомных полей (id → name)."""
        res = self._request("GET", "/company/custom-properties")
        if not res:
            return []
        return [parse_custom_property(p) for p in cast("list[dict[str, Any]]", res)]
