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
import uuid
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request

from mpu.lib import env
from mpu.lib.http_retry import request_with_retry
from mpu.lib.jsonx import dict_items, is_dict

if TYPE_CHECKING:
    from mpu.lib.kaiten_models import (
        KaitenActivity as KaitenActivity,
        KaitenBoard as KaitenBoard,
        KaitenCard as KaitenCard,
        KaitenCardDetail as KaitenCardDetail,
        KaitenColumn as KaitenColumn,
        KaitenComment as KaitenComment,
        KaitenCustomProperty as KaitenCustomProperty,
        KaitenFile as KaitenFile,
        KaitenLane as KaitenLane,
        KaitenLocationChange as KaitenLocationChange,
        KaitenMember as KaitenMember,
        KaitenRole as KaitenRole,
        KaitenSpace as KaitenSpace,
        KaitenTimeLog as KaitenTimeLog,
        KaitenTimeLogEntry as KaitenTimeLogEntry,
        KaitenTimer as KaitenTimer,
        KaitenUser as KaitenUser,
        parse_activity as parse_activity,
        parse_boards_of_space as parse_boards_of_space,
        parse_card as parse_card,
        parse_card_detail as parse_card_detail,
        parse_column as parse_column,
        parse_comment as parse_comment,
        parse_custom_property as parse_custom_property,
        parse_file as parse_file,
        parse_lane as parse_lane,
        parse_location_change as parse_location_change,
        parse_member as parse_member,
        parse_role as parse_role,
        parse_space as parse_space,
        parse_time_log as parse_time_log,
        parse_time_log_entry as parse_time_log_entry,
        parse_timer as parse_timer,
        parse_user as parse_user,
    )

DEFAULT_BASE_URL = "https://btlz.kaiten.ru"
CARDS_PAGE_LIMIT = 100  # Kaiten max amount of cards per response.
# Лента активностей: limit>100 отвергается 400 (в отличие от /cards, где он молча капается).
ACTIVITIES_PAGE_LIMIT = 100
# Действия ленты, по которым видно «я трогал эту карточку» (комментарий / перемещение /
# назначение). Порядок не важен, сервер принимает csv.
DEFAULT_ACTIVITY_ACTIONS = (
    "card_add,card_move,card_archive,comment_add,card_assign_responsible,card_assign_member"
)

_STATE_LABELS = {1: "queued", 2: "in progress", 3: "done"}

# Имена, живущие в lib/kaiten_models.py (pydantic) — реэкспортируются лениво.
_MODEL_EXPORTS = frozenset(
    {
        "KaitenActivity",
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
        "KaitenRole",
        "KaitenSpace",
        "KaitenTimeLog",
        "KaitenTimeLogEntry",
        "KaitenTimer",
        "KaitenUser",
        "parse_activity",
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
        "parse_role",
        "parse_space",
        "parse_time_log",
        "parse_time_log_entry",
        "parse_timer",
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
    responsible_id: int | None = None,
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

    `responsible_id` — ОТДЕЛЬНАЯ ось от `member_ids` (не синоним): участник и
    ответственный — разные роли, и сервер фильтрует по ним независимо.

    `updated_after` / `updated_before` — окно активности (последнее обновление
    карточки), формат ISO 8601 (`YYYY-MM-DDThh:mm:ssZ`). Сервер фильтрует по полю
    `updated`; неизвестные имена он молча игнорирует, поэтому имена точные.
    """
    query: dict[str, str] = {"limit": str(limit), "offset": str(offset)}
    if member_ids is not None:
        query["member_ids"] = member_ids
    if responsible_id is not None:
        query["responsible_id"] = str(responsible_id)
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


def build_multipart(
    fields: dict[str, str], files: list[tuple[str, bytes]], file_field: str = "files[]"
) -> tuple[bytes, str]:
    """Собрать тело multipart/form-data: текстовые поля + файлы.

    Чистая функция (без I/O), покрыта тестами. Каждый файл кладётся отдельным part'ом
    под именем `file_field`. По умолчанию `files[]` — так Kaiten принимает вложения
    комментария (по одному part на файл), привязывая их к создаваемому комментарию;
    для загрузки файла карточки (PUT /cards/{id}/files) поле называется `file`.
    `files` — список `(имя_файла, содержимое)`. Возврат: `(тело, значение заголовка Content-Type)`.
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
        chunks.append(
            f'Content-Disposition: form-data; name="{file_field}"; filename="{safe}"'.encode()
        )
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

        txt = request_with_retry(
            lambda: Request(url, method=method, headers=headers, data=data),
            log_tag="kaiten",
            on_error=lambda status, body: KaitenAPIError(method, path, status, body),
        )
        return json.loads(txt) if txt else None

    def current_user(self) -> KaitenUser:
        """GET /users/current — текущий пользователь по токену."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/users/current")
        return km.parse_user(res)

    def list_cards(  # noqa: PLR0913
        self,
        *,
        member_ids: str | None = None,
        responsible_id: int | None = None,
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
                responsible_id=responsible_id,
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
        for raw in dict_items(res):
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
            lanes.extend(km.parse_lane(raw) for raw in dict_items(res))
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
            columns.extend(km.parse_column(raw) for raw in dict_items(res))
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
        return [km.parse_comment(c) for c in dict_items(res)]

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
        return [km.parse_location_change(c) for c in dict_items(res)]

    def list_custom_properties(self) -> list[KaitenCustomProperty]:
        """GET /company/custom-properties — определения кастомных полей (id → name)."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/company/custom-properties")
        return [km.parse_custom_property(p) for p in dict_items(res)]

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

    def upload_property_file(
        self, card_id: int, property_id: int, filename: str, content: bytes
    ) -> KaitenFile:
        """PUT /cards/{id}/custom-properties/{propertyId}/files — загрузить файл в файловое
        (attachment) кастомное поле карточки (multipart, поле `file`).

        Именно этот эндпоинт привязывает файл к полю: у созданного файла `custom_property_id`
        становится равен `property_id`, а значение поля карточки — массив `uid` его файлов.
        (Обычный POST/PUT /cards/{id}/files кладёт файл на уровень карточки и к полю НЕ
        привязывает.) Возвращает созданный файл (id / url / name / uid).
        """
        from mpu.lib import kaiten_models as km

        raw = build_multipart({}, [(filename, content)], file_field="file")
        res = self._request(
            "PUT", f"/cards/{card_id}/custom-properties/{property_id}/files", raw=raw
        )
        return km.parse_file(res)

    # ── Учёт времени: справочник ролей, записи, таймер ──────────────────────────
    #
    # Ретраи на мутациях ниже НЕ добавлять. Существующий `request_with_retry` повторяет
    # только 429 (запрос гарантированно не обработан) — это безопасно. Повтор упавшего по
    # таймауту POST/PATCH запишет время дважды или ударит в 404 по уже созданному объекту.

    def list_roles(self) -> list[KaitenRole]:
        """GET /user-roles — роли компании («типы работ» для записей учёта времени)."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", "/user-roles")
        return [km.parse_role(r) for r in dict_items(res)]

    def list_time_logs(self, card_id: int) -> list[KaitenTimeLog]:
        """GET /cards/{id}/time-logs — записи учёта времени карточки (ВСЕХ пользователей)."""
        from mpu.lib import kaiten_models as km

        res = self._request("GET", f"/cards/{card_id}/time-logs")
        return [km.parse_time_log(r) for r in dict_items(res)]

    def list_user_time_logs(
        self, user_id: int, *, from_iso: str, to_iso: str
    ) -> list[KaitenTimeLogEntry]:
        """GET /users/{id}/time-logs?from=&to= — записи пользователя за ОКНО, по всем карточкам.

        В каждую запись вложена сама карточка — это единственный дешёвый способ увидеть
        карточки, где время списано БЕЗ членства (обход досок стоил бы сотни запросов).

        ⚠️ `from`/`to` обязательны: без них эндпоинт отвечает 500, а не «за всё время».
        Пагинации у него нет — объём режется только шириной окна (год ≈ 6 МБ, ~3 с).
        """
        from mpu.lib import kaiten_models as km

        res = self._request("GET", f"/users/{user_id}/time-logs", {"from": from_iso, "to": to_iso})
        return [km.parse_time_log_entry(raw, self.base_url) for raw in dict_items(res)]

    def list_my_activities(
        self, *, actions: str = DEFAULT_ACTIVITY_ACTIONS, since_iso: str = "", max_pages: int = 3
    ) -> list[KaitenActivity]:
        """GET /users/current/activities — мои действия по карточкам, свежие первыми.

        Серверного фильтра по дате у эндпоинта НЕТ: `from`/`to`/`since` он принимает, но
        игнорирует (200 с той же выдачей), а `limit` больше 100 отвергает 400 — глубина
        берётся только курсорной пагинацией по `cursor_created`/`cursor_id` последней
        записи страницы.

        Отдаёт то, что удалось достать за `max_pages` страниц. Вызывающий сравнивает
        `created` последнего элемента с нужной датой и сообщает, если до неё не дотянулись
        (молча обрывать охват нельзя — выдача выглядела бы полной).
        """
        from mpu.lib import kaiten_models as km

        out: list[KaitenActivity] = []
        cursor_created, cursor_id = "", ""
        for _ in range(max(1, max_pages)):
            page = dict_items(
                self._request(
                    "GET",
                    "/users/current/activities",
                    {
                        "offset": "0",
                        "limit": str(ACTIVITIES_PAGE_LIMIT),
                        "actions": actions,
                        "cursor_created": cursor_created,
                        "cursor_id": cursor_id,
                    },
                )
            )
            if not page:
                break
            out.extend(km.parse_activity(raw, self.base_url) for raw in page)
            last = page[-1]
            cursor_created = str(last.get("created") or "")
            cursor_id = str(last.get("id") or "")
            if len(page) < ACTIVITIES_PAGE_LIMIT or not cursor_created or not cursor_id:
                break
            # ISO-8601 в одном формате сравним лексикографически: дошли до окна — хватит.
            if since_iso and cursor_created < since_iso:
                break
        return out

    def add_time_log(
        self, card_id: int, *, for_date: str, minutes: int, role_id: int, comment: str = ""
    ) -> KaitenTimeLog:
        """POST /cards/{id}/time-logs — создать запись. `minutes` — единица API (`time_spent`)."""
        from mpu.lib import kaiten_models as km

        body: dict[str, object] = {
            "for_date": for_date,
            "time_spent": minutes,
            "role_id": role_id,
            "comment": comment,
        }
        return km.parse_time_log(self._request("POST", f"/cards/{card_id}/time-logs", body=body))

    def update_time_log(self, card_id: int, log_id: int, body: dict[str, object]) -> KaitenTimeLog:
        """PATCH /cards/{id}/time-logs/{logId} — частичное обновление записи.

        `body` собирает вызывающий (`build_time_log_patch`): попадают только заданные оси.
        Пустая строка в `comment` очищает поле (сервер нормализует её в null).
        """
        from mpu.lib import kaiten_models as km

        res = self._request("PATCH", f"/cards/{card_id}/time-logs/{log_id}", body=body)
        return km.parse_time_log(res)

    def delete_time_log(self, card_id: int, log_id: int) -> None:
        """DELETE /cards/{id}/time-logs/{logId} — удалить запись учёта времени."""
        self._request("DELETE", f"/cards/{card_id}/time-logs/{log_id}")

    def start_timer(self, card_id: int, *, comment: str = "") -> KaitenTimer | None:
        """POST /user-timers — запустить таймер на карточке.

        Роль здесь передавать бессмысленно: API её принимает, но не хранит (тип работы
        выбирается при остановке) — поэтому параметра нет.

        Таймер на карточке уже есть → сервер отвечает телом-сообщением
        (`{"message": "User timer already created"}`) БЕЗ `id`, и не обязательно
        HTTP-ошибкой. Ветвимся по форме ответа: в этом случае возвращаем None.
        """
        from mpu.lib import kaiten_models as km

        body: dict[str, object] = {"card_id": card_id}
        if comment:
            body["comment"] = comment
        res = self._request("POST", "/user-timers", body=body)
        if not is_dict(res) or "id" not in res:
            return None
        return km.parse_timer(res)

    def stop_timer(
        self,
        timer_id: int,
        *,
        finished_at: str,
        started_at: str | None = None,
        comment: str | None = None,
        role_id: int | None = None,
    ) -> KaitenTimer:
        """PATCH /user-timers/{id} — остановить таймер; создаёт запись учёта времени.

        `finished_at` — обязательный keyword ПО КОНСТРУКЦИИ: PATCH без `started_at` и без
        `finished_at` отвечает HTTP 500, и требование на уровне сигнатуры делает эту ветку
        недостижимой. Передавать `finished_at=None` нельзя — сервер вернёт 400.

        Длительность записи сервер считает как `finished_at - started_at` с округлением
        ВВЕРХ до минуты; `started_at` передаём только когда нужно записать не фактическое,
        а заданное время (см. `timer_window`). Роль применяется именно здесь.
        Возвращённый таймер несёт `card_time_log_id` созданной записи.
        """
        from mpu.lib import kaiten_models as km

        body: dict[str, object] = {"finished_at": finished_at}
        if started_at is not None:
            body["started_at"] = started_at
        if comment is not None:
            body["comment"] = comment
        if role_id is not None:
            body["role_id"] = role_id
        return km.parse_timer(self._request("PATCH", f"/user-timers/{timer_id}", body=body))

    def discard_timer(self, timer_id: int) -> None:
        """DELETE /user-timers/{id} — сбросить таймер БЕЗ создания записи учёта времени."""
        self._request("DELETE", f"/user-timers/{timer_id}")

    def delete_card_file(self, card_id: int, file_id: int) -> None:
        """DELETE /cards/{id}/files/{fileId} — удалить файл карточки.

        Если файл был привязан к файловому кастомному полю (`custom_property_id`), значение
        поля карточки при этом очищается автоматически. Идемпотентно на уровне вызывающего.
        """
        self._request("DELETE", f"/cards/{card_id}/files/{file_id}")
