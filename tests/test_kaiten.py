"""Тесты `mpu.lib.kaiten` — чистые парсеры/билдеры + I/O-клиент `KaitenClient`.

Дополняет `test_kiten.py` (там — чистые функции команды `mpu kiten`): здесь покрыты
функции и ветки самого `lib/kaiten`, которых там нет — `parse_location_change`,
edge-ветки `build_cards_query`/`parse_boards_of_space`/`parse_card_detail`, исключение
`KaitenAPIError`, и сам HTTP-клиент через подмену `urlopen` (без реальной сети):
сборка запроса, ретрай на 429, маппинг ошибок, пагинация, best-effort-пропуски.
"""

from __future__ import annotations

import io
import json
from email.message import Message
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from mpu.lib import kaiten
from mpu.lib.kaiten import (
    CARDS_PAGE_LIMIT,
    DEFAULT_BASE_URL,
    KaitenAPIError,
    KaitenClient,
    build_cards_query,
    parse_boards_of_space,
    parse_card_detail,
    parse_column,
    parse_location_change,
)

# ── Чистые функции / ветки, не покрытые в test_kiten.py ─────────────────────────


def test_kaiten_api_error_attrs_and_truncated_message() -> None:
    err = KaitenAPIError("GET", "/cards/5", 500, "x" * 400)
    assert (err.method, err.path, err.status) == ("GET", "/cards/5", 500)
    assert err.body == "x" * 400  # тело хранится целиком
    text = str(err)
    assert text.startswith("kaiten GET /cards/5 -> 500: ")
    # в текст сообщения тело обрезано до 300 символов.
    assert "x" * 300 in text
    assert "x" * 301 not in text


def test_build_cards_query_omits_none_member_ids() -> None:
    # member_ids=None — ветка пропуска (в test_kiten все кейсы передают member_ids).
    query = build_cards_query(condition=2)
    assert query == {"limit": "100", "offset": "0", "condition": "2"}
    assert "member_ids" not in query


def test_parse_column_with_sort_order_float() -> None:
    # sort_order присутствует → float-ветка (в test_kiten покрыт только None-кейс).
    col = parse_column({"id": 1, "board_id": 2, "title": "X", "sort_order": "2.5"})
    assert col.sort_order == 2.5


def test_parse_boards_of_space_skips_non_dict_entries() -> None:
    raw = {"id": 1, "boards": [{"id": 9, "title": "B"}, "garbage", 42, None]}
    boards = parse_boards_of_space(raw)
    assert [b.id for b in boards] == [9]  # мусорные элементы списка отброшены


def test_parse_card_detail_skips_garbage_members_files_tags() -> None:
    # _dict_items отбрасывает не-dict элементы списков (members/files/tags).
    raw = {
        "id": 1,
        "members": [{"id": 2, "full_name": "M"}, "garbage", 99],
        "files": [{"id": 5, "url": "u", "name": "n"}, None],
        "tags": [{"name": "T"}, "x"],
    }
    d = parse_card_detail(raw, "https://btlz.kaiten.ru")
    assert [m.id for m in d.members] == [2]
    assert [f.id for f in d.files] == [5]
    assert d.tags == ["T"]  # строка "x" не dict → пропущена _dict_items


def test_parse_card_detail_coerces_non_string_property() -> None:
    # select/catalog-значения (число/массив) приводятся к str, None отбрасывается.
    d = parse_card_detail(
        {"id": 1, "properties": {"id_5": 42, "id_6": [1, 2], "id_7": None}},
        "https://btlz.kaiten.ru",
    )
    assert d.properties == {"id_5": "42", "id_6": "[1, 2]"}


# ── parse_location_change: целиком не покрыта в test_kiten ──────────────────────


def test_parse_location_change_full() -> None:
    raw = {
        "card_id": 5,
        "column_id": 30,
        "lane_id": 7,
        "author_id": 9,
        "author": {"full_name": "Боб", "username": "bob"},
        "changed": "2026-06-01T10:00:00Z",
    }
    ch = parse_location_change(raw)
    assert (ch.card_id, ch.column_id, ch.lane_id, ch.author_id) == (5, 30, 7, 9)
    assert ch.author_name == "Боб"
    assert ch.changed == "2026-06-01T10:00:00Z"


def test_parse_location_change_all_nulls() -> None:
    # нет column/lane/author/changed → None; _member_name(None) → "" → None.
    ch = parse_location_change({"card_id": 5})
    assert ch.column_id is None
    assert ch.lane_id is None
    assert ch.author_id is None
    assert ch.author_name is None
    assert ch.changed is None


def test_parse_location_change_explicit_null_ids() -> None:
    # явные null в column_id/author_id → None (ветка `is None`).
    ch = parse_location_change({"card_id": 5, "column_id": None, "author_id": None})
    assert ch.column_id is None
    assert ch.author_id is None


def test_parse_location_change_author_username_fallback() -> None:
    # нет full_name → username; _member_name возвращает username.
    ch = parse_location_change({"card_id": 5, "author": {"username": "bob"}})
    assert ch.author_name == "bob"


# ── Фейковый транспорт поверх urlopen (без сети) ────────────────────────────────


class _FakeResponse:
    """Мини-объект ответа: контекст-менеджер с .read() — как http.client.HTTPResponse."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


class _FakeTransport:
    """Очередь ответов на `urlopen`. Записывает запросы для проверки сборки запроса.

    Элемент очереди: bytes (тело ответа) или HTTPError (поднимается как из urllib).
    """

    def __init__(self) -> None:
        self.requests: list[Request] = []
        self._responses: list[bytes | HTTPError] = []

    def queue(self, payload: object) -> None:
        """JSON-ответ (сериализуется)."""
        self._responses.append(json.dumps(payload).encode("utf-8"))

    def queue_raw(self, payload: bytes) -> None:
        """Сырое тело (для проверки пустого ответа `b""`)."""
        self._responses.append(payload)

    def queue_error(self, err: HTTPError) -> None:
        self._responses.append(err)

    def __call__(self, req: Request) -> _FakeResponse:
        self.requests.append(req)
        nxt = self._responses.pop(0)
        if isinstance(nxt, HTTPError):
            raise nxt
        return _FakeResponse(nxt)


def _http_error(code: int, body: str = "", *, retry_after: str | None = None) -> HTTPError:
    hdrs = Message()
    if retry_after is not None:
        hdrs["Retry-After"] = retry_after
    return HTTPError(
        url="https://btlz.kaiten.ru/api/latest/x",
        code=code,
        msg="error",
        hdrs=hdrs,
        fp=io.BytesIO(body.encode("utf-8")),
    )


def _no_sleep(seconds: float) -> None:
    return None


def _make_client(monkeypatch: pytest.MonkeyPatch) -> tuple[KaitenClient, _FakeTransport]:
    transport = _FakeTransport()
    monkeypatch.setattr(kaiten, "urlopen", transport)
    monkeypatch.setattr(kaiten.time, "sleep", _no_sleep)
    return KaitenClient(token="tok", base_url="https://btlz.kaiten.ru"), transport


def _body(req: Request) -> object:
    data = req.data
    assert isinstance(data, bytes)
    return json.loads(data)


# ── KaitenClient.__init__ / from_env ───────────────────────────────────────────


def test_client_init_defaults() -> None:
    client = KaitenClient(token="t")
    assert client.token == "t"
    assert client.base_url == DEFAULT_BASE_URL
    assert client.api_base == f"{DEFAULT_BASE_URL}/api/latest"


def test_client_init_strips_trailing_slash() -> None:
    client = KaitenClient(token="t", base_url="https://acme.kaiten.ru/")
    assert client.base_url == "https://acme.kaiten.ru"
    assert client.api_base == "https://acme.kaiten.ru/api/latest"


def test_from_env_uses_configured_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_require(name: str) -> str:
        return "secret-token"

    def fake_get(name: str, default: str | None = None) -> str | None:
        return "https://acme.kaiten.ru/"

    monkeypatch.setattr(kaiten.env, "require", fake_require)
    monkeypatch.setattr(kaiten.env, "get", fake_get)
    client = KaitenClient.from_env()
    assert client.token == "secret-token"
    assert client.base_url == "https://acme.kaiten.ru"  # trailing slash убран


def test_from_env_falls_back_to_default_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_require(name: str) -> str:
        return "tok"

    def fake_get(name: str, default: str | None = None) -> str | None:
        return None

    monkeypatch.setattr(kaiten.env, "require", fake_require)
    monkeypatch.setattr(kaiten.env, "get", fake_get)
    client = KaitenClient.from_env()
    assert client.base_url == DEFAULT_BASE_URL


# ── _request: успех / пустое тело / ретрай 429 / маппинг ошибки ─────────────────


def test_request_builds_url_and_returns_json(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 7, "full_name": "Иван", "username": "ivan", "email": "i@x"})
    user = client.current_user()
    assert (user.id, user.full_name, user.username, user.email) == (7, "Иван", "ivan", "i@x")
    req = transport.requests[0]
    assert req.get_method() == "GET"
    assert req.full_url.endswith("/api/latest/users/current")


def test_current_user_defaults_missing_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 1})
    user = client.current_user()
    assert (user.full_name, user.username, user.email) == ("", "", "")


def test_request_retries_on_429_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(429, retry_after="0"))
    transport.queue({"id": 1, "full_name": "A", "username": "a", "email": "a@x"})
    user = client.current_user()
    assert user.id == 1
    assert len(transport.requests) == 2  # один ретрай после 429


def test_request_429_without_retry_after_header(monkeypatch: pytest.MonkeyPatch) -> None:
    # заголовок Retry-After отсутствует → берётся дефолтный backoff, всё равно ретраит.
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(429))
    transport.queue({"id": 2, "full_name": "B", "username": "b", "email": "b@x"})
    assert client.current_user().id == 2


def test_request_429_exhausts_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    for _ in range(6):
        transport.queue_error(_http_error(429, retry_after="0"))
    with pytest.raises(KaitenAPIError) as exc:
        client.current_user()
    assert exc.value.status == 429
    assert exc.value.body == "exhausted retries"
    assert len(transport.requests) == 6  # ровно 6 попыток


def test_request_non_429_raises_api_error(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(404, body="not found"))
    with pytest.raises(KaitenAPIError) as exc:
        client.current_user()
    assert exc.value.status == 404
    assert exc.value.method == "GET"
    assert "not found" in exc.value.body
    assert len(transport.requests) == 1  # не-429 не ретраится


# ── list_cards: фильтры в URL + пагинация по offset ────────────────────────────


def test_list_cards_single_partial_page(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([{"id": 1, "title": "A"}, {"id": 2, "title": "B"}])
    cards = client.list_cards(member_ids="10", board_id=7)
    assert [c.id for c in cards] == [1, 2]
    url = transport.requests[0].full_url
    assert "member_ids=10" in url
    assert "board_id=7" in url
    assert "offset=0" in url
    assert len(transport.requests) == 1  # неполная страница → второй страницы нет


def test_list_cards_empty_first_page(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([])
    assert client.list_cards() == []
    assert len(transport.requests) == 1


def test_list_cards_paginates_until_short_page(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    full = [{"id": i, "title": f"c{i}"} for i in range(CARDS_PAGE_LIMIT)]
    transport.queue(full)
    transport.queue([{"id": 9999, "title": "last"}])
    cards = client.list_cards()
    assert len(cards) == CARDS_PAGE_LIMIT + 1
    assert cards[-1].id == 9999
    assert len(transport.requests) == 2
    assert "offset=100" in transport.requests[1].full_url  # смещение на размер страницы


# ── list_spaces / list_lanes / list_columns ────────────────────────────────────


def test_list_spaces_with_embedded_boards(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    payload: list[dict[str, object]] = [
        {
            "id": 1,
            "title": "S1",
            "archived": False,
            "boards": [{"id": 10, "title": "B1", "space_id": 1}],
        },
        {"id": 2, "title": "S2", "archived": True, "boards": []},
    ]
    transport.queue(payload)
    spaces, boards = client.list_spaces()
    assert [s.id for s in spaces] == [1, 2]
    assert spaces[1].archived is True
    assert [(b.id, b.space_id) for b in boards] == [(10, 1)]


def test_list_spaces_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([])
    assert client.list_spaces() == ([], [])


def test_list_lanes_best_effort_skips_failed_and_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([{"id": 100, "board_id": 1, "title": "L1"}])  # доска 1 — ок
    transport.queue_error(_http_error(403))  # доска 2 — ошибка → пропуск
    transport.queue([])  # доска 3 — пусто → пропуск
    lanes = client.list_lanes([1, 2, 3])
    assert [lane.id for lane in lanes] == [100]
    assert len(transport.requests) == 3


def test_list_columns_best_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([{"id": 30, "board_id": 1, "title": "Готово", "sort_order": 3.0}])  # доска 1
    transport.queue_error(_http_error(500))  # доска 2 — ошибка → пропуск
    transport.queue([])  # доска 3 — пусто → пропуск
    cols = client.list_columns([1, 2, 3])
    assert [(c.id, c.sort_order) for c in cols] == [(30, 3.0)]


# ── get_card / get_comments / location_history / custom_properties ─────────────


def test_get_card(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 5, "title": "T", "board": {"id": 1, "title": "B"}})
    d = client.get_card(5)
    assert d.id == 5
    assert d.board_title == "B"
    assert transport.requests[0].full_url.endswith("/cards/5")


def test_get_comments(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue(
        [{"id": 1, "text": "hi", "author": {"full_name": "Bob"}, "created": "2026-06-01"}]
    )
    comments = client.get_comments(5)
    assert [(c.id, c.author_name) for c in comments] == [(1, "Bob")]


def test_get_comments_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([])
    assert client.get_comments(5) == []


def test_location_history(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue(
        [
            {
                "card_id": 5,
                "column_id": 30,
                "lane_id": 7,
                "author_id": 9,
                "author": {"full_name": "Bob"},
                "changed": "2026-06-01T00:00:00Z",
            }
        ]
    )
    hist = client.location_history(5)
    assert hist[0].column_id == 30
    assert hist[0].author_name == "Bob"


def test_location_history_error_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(404))
    assert client.location_history(5) == []  # best-effort


def test_location_history_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([])
    assert client.location_history(5) == []


def test_list_custom_properties(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([{"id": 1, "name": "MR", "type": "link"}])
    props = client.list_custom_properties()
    assert [(p.id, p.name, p.type) for p in props] == [(1, "MR", "link")]


def test_list_custom_properties_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue([])
    assert client.list_custom_properties() == []


# ── add_comment / move_card / set_card_property: сборка тела запроса ────────────


def test_add_comment_text_only_sends_json(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 1, "text": "hi", "author": {"full_name": "Me"}, "created": None})
    c = client.add_comment(5, "hi")
    assert c.id == 1
    req = transport.requests[0]
    assert req.get_method() == "POST"
    assert req.full_url.endswith("/cards/5/comments")
    assert _body(req) == {"text": "hi"}


def test_add_comment_with_files_sends_multipart(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 2, "text": "see", "author": {"full_name": "Me"}, "created": None})
    c = client.add_comment(5, "see", files=[("a.txt", b"DATA")])
    assert c.id == 2
    data = transport.requests[0].data
    assert isinstance(data, bytes)
    assert b'name="files[]"' in data
    assert b'filename="a.txt"' in data
    assert b"DATA" in data


def test_move_card_sends_only_provided_axes(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 5, "title": "T", "column": {"id": 30, "title": "Готово"}})
    d = client.move_card(5, column_id=30, board_id=1)
    assert d.column_title == "Готово"
    req = transport.requests[0]
    assert req.get_method() == "PATCH"
    assert _body(req) == {"board_id": 1, "column_id": 30}  # lane_id опущен


def test_move_card_lane_axis(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 5, "title": "T", "lane": {"title": "Support"}})
    d = client.move_card(5, lane_id=844615)
    assert d.lane_title == "Support"
    assert _body(transport.requests[0]) == {"lane_id": 844615}


def test_move_card_empty_body_when_no_axes(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": 5, "title": "T"})
    client.move_card(5)
    assert _body(transport.requests[0]) == {}


def test_set_card_property_value(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({})
    result = client.set_card_property(5, "id_398965", "https://mr/1")
    assert result is None
    req = transport.requests[0]
    assert req.get_method() == "PATCH"
    assert _body(req) == {"properties": {"id_398965": "https://mr/1"}}


def test_set_card_property_clear_sends_null_and_handles_empty_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_raw(b"")  # PATCH вернул пустое тело → _request отдаёт None
    result = client.set_card_property(5, "id_398965", None)
    assert result is None
    assert _body(transport.requests[0]) == {"properties": {"id_398965": None}}
