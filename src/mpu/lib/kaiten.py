"""Тонкий клиент Kaiten REST API (https://<instance>.kaiten.ru/api/latest).

Используется из `mpu kiten`. По образцу `mpu/lib/miro.py` — stdlib urllib + json,
Bearer-auth, retry на 429 (rate-limit Kaiten — 5 req/s).

Модели ответов и парсеры — pydantic, в `lib/kaiten_models.py`; здесь они доступны
через ленивый модульный `__getattr__` (`from mpu.lib.kaiten import KaitenCard`
работает, но pydantic загружается только при первом обращении — startup CLI
нейтрален, см. CLAUDE.md «Стек»). Чистые функции (`state_label`, `card_url`,
`build_cards_query`, `parse_card_ref`, `build_multipart`) отделены от I/O
(`KaitenClient`) и покрыты тестами без сети — сам HTTP-клиент, как и miro/slapi,
тестами не покрывается.
"""

from __future__ import annotations

import json
import mimetypes
import sys
import time
import uuid
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from mpu.lib import env

if TYPE_CHECKING:
    from mpu.lib.kaiten_models import (
        KaitenBoard as KaitenBoard,
    )
    from mpu.lib.kaiten_models import (
        KaitenCard as KaitenCard,
    )
    from mpu.lib.kaiten_models import (
        KaitenCardDetail as KaitenCardDetail,
    )
    from mpu.lib.kaiten_models import (
        KaitenColumn as KaitenColumn,
    )
    from mpu.lib.kaiten_models import (
        KaitenComment as KaitenComment,
    )
    from mpu.lib.kaiten_models import (
        KaitenCustomProperty as KaitenCustomProperty,
    )
    from mpu.lib.kaiten_models import (
        KaitenFile as KaitenFile,
    )
    from mpu.lib.kaiten_models import (
        KaitenLane as KaitenLane,
    )
    from mpu.lib.kaiten_models import (
        KaitenLocationChange as KaitenLocationChange,
    )
    from mpu.lib.kaiten_models import (
        KaitenMember as KaitenMember,
    )
    from mpu.lib.kaiten_models import (
        KaitenSpace as KaitenSpace,
    )
    from mpu.lib.kaiten_models import (
        KaitenUser as KaitenUser,
    )
    from mpu.lib.kaiten_models import (
        parse_boards_of_space as parse_boards_of_space,
    )
    from mpu.lib.kaiten_models import (
        parse_card as parse_card,
    )
    from mpu.lib.kaiten_models import (
        parse_card_detail as parse_card_detail,
    )
    from mpu.lib.kaiten_models import (
        parse_column as parse_column,
    )
    from mpu.lib.kaiten_models import (
        parse_comment as parse_comment,
    )
    from mpu.lib.kaiten_models import (
        parse_custom_property as parse_custom_property,
    )
    from mpu.lib.kaiten_models import (
        parse_file as parse_file,
    )
    from mpu.lib.kaiten_models import (
        parse_lane as parse_lane,
    )
    from mpu.lib.kaiten_models import (
        parse_location_change as parse_location_change,
    )
    from mpu.lib.kaiten_models import (
        parse_member as parse_member,
    )
    from mpu.lib.kaiten_models import (
        parse_space as parse_space,
    )
    from mpu.lib.kaiten_models import (
        parse_user as parse_user,
    )

DEFAULT_BASE_URL = "https://btlz.kaiten.ru"
CARDS_PAGE_LIMIT = 100  # Kaiten max amount of cards per response.

_STATE_LABELS = {1: "queued", 2: "in progress", 3: "done"}

# Имена, живущие в lib/kaiten_models.py (pydantic) — реэкспортируются лениво.
_MODEL_EXPORTS = frozenset(
    {
        "KaitenBoard",
        "KaitenCard",
        "KaitenCardDetail",
        "KaitenColumn",
        "KaitenComment",
        "KaitenCustomProperty",
        "KaitenFile",
        "KaitenLane",
        "KaitenLocationChange",
        "KaitenMember",
        "KaitenSpace",
        "KaitenUser",
        "parse_boards_of_space",
        "parse_card",
        "parse_card_detail",
        "parse_column",
        "parse_comment",
        "parse_custom_property",
        "parse_file",
        "parse_lane",
        "parse_location_change",
        "parse_member",
        "parse_space",
        "parse_user",
    }
)


def __getattr__(name: str) -> object:
    """Ленивый re-export моделей/парсеров: pydantic грузится при первом обращении."""
    if name in _MODEL_EXPORTS:
        from mpu.lib import kaiten_models

        return getattr(kaiten_models, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


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


def build_cards_query(  # noqa: PLR0913
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


def build_multipart(fields: dict[str, str], files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    """Собрать тело multipart/form-data: текстовые поля + файлы.

    Чистая функция (без I/O), покрыта тестами. Каждый файл кладётся отдельным part'ом
    под именем `files[]` — именно так Kaiten принимает вложения комментария (поле `files[]`,
    по одному part на файл), привязывая их к создаваемому комментарию. `files` — список
    `(имя_файла, содержимое)`. Возврат: `(тело, значение заголовка Content-Type)`.
    """
    boundary = f"----mpu{uuid.uuid4().hex}"
    crlf = b"\r\n"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        chunks.append(b"")
        chunks.append(value.encode("utf-8"))
    for filename, content in files:
        # Имя в заголовке не должно содержать кавычек/переводов строки — иначе ломается part.
        safe = filename.replace('"', "%22").replace("\r", " ").replace("\n", " ")
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        chunks.append(f"--{boundary}".encode())
        chunks.append(f'Content-Disposition: form-data; name="files[]"; filename="{safe}"'.encode())
        chunks.append(f"Content-Type: {mime}".encode())
        chunks.append(b"")
        chunks.append(content)
    chunks.append(f"--{boundary}--".encode())
    chunks.append(b"")
    return crlf.join(chunks), f"multipart/form-data; boundary={boundary}"


# ── I/O-клиент (HTTP, тестами не покрывается — как miro/slapi) ──────────────────
# Внутри методов модели импортируются лениво (`from mpu.lib import kaiten_models`):
# первый реальный запрос платит ~150 мс импорта pydantic, startup CLI — нет.


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

    def _request(
        self,
        method: str,
        path: str,
        query: dict[str, str] | None = None,
        body: Any | None = None,  # noqa: ANN401
        raw: tuple[bytes, str] | None = None,
    ) -> Any:  # noqa: ANN401
        url = f"{self.api_base}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        data: bytes | None = None
        if raw is not None:
            # Готовое тело (напр. multipart/form-data) — не сериализуем как JSON.
            data, content_type = raw
            headers["Content-Type"] = content_type
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        backoff = 1.0
        for _ in range(6):
            req = Request(url, method=method, headers=headers, data=data)
            try:
                with urlopen(req) as r:
                    txt = r.read().decode("utf-8")
                    return json.loads(txt) if txt else None
            except HTTPError as e:
                err_body = e.read().decode("utf-8", "replace")
                if e.code == 429:  # noqa: PLR2004
                    wait = int(e.headers.get("Retry-After", str(int(backoff))))
                    print(f"[kaiten] 429 rate-limit, sleep {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    backoff = min(backoff * 2, 30)
                    continue
                raise KaitenAPIError(method, path, e.code, err_body) from None
        raise KaitenAPIError(method, path, 429, "exhausted retries")

    def current_user(self) -> KaitenUser:
        """GET /users/current — текущий пользователь по токену."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/users/current")
        return km.parse_user(res)

    def list_cards(  # noqa: PLR0913
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
        from mpu.lib import kaiten_models as km

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
            cards.extend(km.parse_card(c, self.base_url) for c in page)
            if len(page) < CARDS_PAGE_LIMIT:
                break
            offset += CARDS_PAGE_LIMIT
        return cards

    def list_spaces(self) -> tuple[list[KaitenSpace], list[KaitenBoard]]:
        """GET /spaces — справочник. Boards встроены в каждый space, отдаём их плоско.

        Глобального GET /boards у Kaiten нет (405), поэтому boards собираются из
        вложенного `boards[]` каждого space за один запрос.
        """
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/spaces")
        spaces: list[KaitenSpace] = []
        boards: list[KaitenBoard] = []
        for raw in km.dict_items(res):
            spaces.append(km.parse_space(raw))
            boards.extend(km.parse_boards_of_space(raw))
        return spaces, boards

    def list_lanes(self, board_ids: list[int]) -> list[KaitenLane]:
        """GET /boards/{id}/lanes для каждой доски, плоский список.

        Best-effort: доска, которая отдала ошибку (нет доступа и т.п.), пропускается,
        чтобы один сбой не валил весь обход. Глобального списка дорожек у Kaiten нет.
        """
        from mpu.lib import kaiten_models as km

        lanes: list[KaitenLane] = []
        for board_id in board_ids:
            try:
                res = self._request("GET", f"/boards/{board_id}/lanes")
            except KaitenAPIError:
                continue
            lanes.extend(km.parse_lane(raw) for raw in km.dict_items(res))
        return lanes

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        """GET /boards/{id}/columns по доскам, плоский список. Best-effort (как list_lanes)."""
        from mpu.lib import kaiten_models as km

        columns: list[KaitenColumn] = []
        for board_id in board_ids:
            try:
                res = self._request("GET", f"/boards/{board_id}/columns")
            except KaitenAPIError:
                continue
            columns.extend(km.parse_column(raw) for raw in km.dict_items(res))
        return columns

    def get_card(self, card_id: int) -> KaitenCardDetail:
        """GET /cards/{id} — полная карточка (описание, файлы, участники, properties)."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", f"/cards/{card_id}")
        return km.parse_card_detail(res, self.base_url)

    def get_comments(self, card_id: int) -> list[KaitenComment]:
        """GET /cards/{id}/comments — комментарии (хронологически). `text` — GFM markdown."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", f"/cards/{card_id}/comments")
        return [km.parse_comment(c) for c in km.dict_items(res)]

    def location_history(self, card_id: int) -> list[KaitenLocationChange]:
        """GET /cards/{id}/location-history — кто и когда менял колонку/дорожку карточки.

        Хронология перемещений (есть `author_id` и `changed` ISO-UTC). Используется
        `telegram status --live`, чтобы поймать перемещения, сделанные не через инструмент.
        Best-effort: ошибка/пусто → []."""
        from mpu.lib import kaiten_models as km

        try:
            res = self._request("GET", f"/cards/{card_id}/location-history")
        except KaitenAPIError:
            return []
        return [km.parse_location_change(c) for c in km.dict_items(res)]

    def list_custom_properties(self) -> list[KaitenCustomProperty]:
        """GET /company/custom-properties — определения кастомных полей (id → name)."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/company/custom-properties")
        return [km.parse_custom_property(p) for p in km.dict_items(res)]

    def add_comment(
        self, card_id: int, text: str, files: list[tuple[str, bytes]] | None = None
    ) -> KaitenComment:
        """POST /cards/{id}/comments — добавить комментарий от имени владельца токена.

        Автор определяется сервером по `KITEN_API_KEY` (отдельного поля автора нет —
        комментарий всегда «от моего имени»). Возвращает созданный комментарий.

        Без `files` — JSON-тело `{text}`. С вложениями (`[(имя, байты)]`) — один POST
        multipart/form-data: поле `text` + по одному `files[]` на файл; Kaiten создаёт
        комментарий и привязывает файлы к нему (`file.comment_id` = id комментария).
        """
        from mpu.lib import kaiten_models as km

        if not files:
            res = self._request("POST", f"/cards/{card_id}/comments", body={"text": text})
            return km.parse_comment(res)
        raw = build_multipart({"text": text}, files)
        res = self._request("POST", f"/cards/{card_id}/comments", raw=raw)
        return km.parse_comment(res)

    def move_card(
        self,
        card_id: int,
        *,
        lane_id: int | None = None,
        column_id: int | None = None,
        board_id: int | None = None,
    ) -> KaitenCardDetail:
        """PATCH /cards/{id} — переместить карточку: дорожка / колонка / доска.

        В тело попадают только заданные оси (None — не трогаем). `board_id` нужен при
        переносе на другую доску (дорожка/колонка тогда должны принадлежать ей).
        Возвращает обновлённую карточку (с новым положением во вложенных `board`/`column`/`lane`).
        """
        from mpu.lib import kaiten_models as km

        body: dict[str, int] = {}
        if board_id is not None:
            body["board_id"] = board_id
        if column_id is not None:
            body["column_id"] = column_id
        if lane_id is not None:
            body["lane_id"] = lane_id
        res = self._request("PATCH", f"/cards/{card_id}", body=body)
        return km.parse_card_detail(res, self.base_url)

    def set_card_property(self, card_id: int, property_key: str, value: str | None) -> None:
        """PATCH /cards/{id} — установить кастомное поле (`value=None` — очистить).

        `property_key` — ключ поля карточки вида `id_NNN` (см. `kaiten_links.property_key`).
        """
        self._request("PATCH", f"/cards/{card_id}", body={"properties": {property_key: value}})
