"""Тесты `mpu.lib.miro` — клиент Miro REST API v2 поверх stdlib `urllib`.

Сеть не дёргается: `urlopen` подменяется фейковым транспортом (очередь ответов /
ошибок, запись запросов для проверки сборки url/headers/body), `time.sleep` —
no-op-рекордером (ретраи на 429 без реального ожидания). Покрыты: сборка запроса,
парсинг 200, маппинг 4xx/404 → `MiroAPIError`, ретрай 429 (успех/исчерпание),
пустой/мусорный ответ, и все публичные методы (frames / shapes / connectors /
delete_frame с разлочкой залоченных элементов).
"""
# pyright: reportPrivateUsage=false
# (тестируем приватные `_request` / `_iter_children` / `_delete_endpoint_for`.)

from __future__ import annotations

import io
import json
from email.message import Message
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request

import pytest

from mpu.lib import miro
from mpu.lib.miro import API_BASE, FrameRef, MiroAPIError, MiroClient

BASE = f"{API_BASE}/v2/boards/B"


# ── Фейковый транспорт поверх urlopen (без сети) ────────────────────────────────


class _FakeResponse:
    """Мини-ответ: контекст-менеджер с `.read()` — как `http.client.HTTPResponse`."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


class _FakeTransport:
    """Очередь ответов на `urlopen`. Пишет запросы и переданные в `sleep` интервалы.

    Элемент очереди: bytes (тело ответа) или HTTPError (поднимается как из urllib).
    """

    def __init__(self) -> None:
        self.requests: list[Request] = []
        self.sleeps: list[float] = []
        self._responses: list[bytes | HTTPError] = []

    def queue(self, payload: object) -> None:
        """JSON-ответ (сериализуется)."""
        self._responses.append(json.dumps(payload).encode("utf-8"))

    def queue_raw(self, payload: bytes) -> None:
        """Сырое тело (пустой `b""` / мусор, не проходящий json.loads)."""
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
        url="https://api.miro.com/v2/boards/B/items",
        code=code,
        msg="error",
        hdrs=hdrs,
        fp=io.BytesIO(body.encode("utf-8")),
    )


def _make_client(monkeypatch: pytest.MonkeyPatch) -> tuple[MiroClient, _FakeTransport]:
    transport = _FakeTransport()

    def _sleep(seconds: float) -> None:
        transport.sleeps.append(seconds)

    monkeypatch.setattr(miro, "urlopen", transport)
    monkeypatch.setattr(miro.time, "sleep", _sleep)
    return MiroClient(token="tok", board_id_raw="B"), transport


def _body(req: Request) -> object:
    data = req.data
    assert isinstance(data, bytes)
    return json.loads(data)


# ── __init__ / квотирование board_id ───────────────────────────────────────────


def test_client_init_quotes_board_id() -> None:
    raw = "board/with=special chars"
    c = MiroClient(token="secret", board_id_raw=raw)
    assert c.token == "secret"
    assert c.board_id == quote(raw, safe="")
    assert c.base == f"{API_BASE}/v2/boards/{quote(raw, safe='')}"
    # spaces/slash/= должны быть закодированы — иначе сломается путь.
    assert "/" not in c.board_id
    assert " " not in c.board_id


# ── _request: сборка url/headers/body ───────────────────────────────────────────


def test_request_get_no_body_headers_and_url(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"ok": True})
    res = client._request("GET", "/items?limit=50")
    assert res == {"ok": True}
    req = transport.requests[0]
    assert req.get_method() == "GET"
    assert req.full_url == f"{BASE}/items?limit=50"
    assert req.data is None
    assert req.headers["Authorization"] == "Bearer tok"
    assert req.headers["Accept"] == "application/json"
    # без тела Content-Type не выставляется (urllib капитализирует ключ).
    assert "Content-type" not in req.headers


def test_request_post_with_body_sets_content_type(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "x"})
    res = client._request("POST", "/shapes", {"a": 1, "b": "z"})
    assert res == {"id": "x"}
    req = transport.requests[0]
    assert req.get_method() == "POST"
    assert req.headers["Content-type"] == "application/json"
    assert _body(req) == {"a": 1, "b": "z"}


def test_request_absolute_path_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    """path без ведущего `/` → url склеивается от API_BASE, а не от board-base."""
    client, transport = _make_client(monkeypatch)
    transport.queue({})
    client._request("GET", "v2/anything")
    assert transport.requests[0].full_url == f"{API_BASE}v2/anything"


# ── _request: парсинг тела / пустой / мусор ─────────────────────────────────────


def test_request_empty_body_returns_empty_dict(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_raw(b"")
    assert client._request("DELETE", "/items/i1") == {}


def test_request_garbage_body_raises_json_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Не-JSON тело при 200 → json.loads бросает (текущее поведение, не глотается)."""
    client, transport = _make_client(monkeypatch)
    transport.queue_raw(b"not json{")
    with pytest.raises(json.JSONDecodeError):
        client._request("GET", "/items")


# ── _request: ошибки / ретраи 429 ───────────────────────────────────────────────


def test_request_404_raises_miro_api_error(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(404, body="no such item"))
    with pytest.raises(MiroAPIError) as exc:
        client._request("GET", "/items/i1")
    err = exc.value
    assert err.status == 404
    assert err.method == "GET"
    assert err.path == "/items/i1"
    assert err.body == "no such item"
    assert len(transport.requests) == 1  # не-429 не ретраится


def test_request_429_retry_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(429, retry_after="0"))
    transport.queue({"id": "ok"})
    assert client._request("GET", "/items") == {"id": "ok"}
    assert len(transport.requests) == 2  # один ретрай после 429
    assert transport.sleeps == [0]  # Retry-After=0


def test_request_429_backoff_default_when_no_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без Retry-After ретрай всё равно идёт, sleep растёт по дефолтному backoff (1,2,…)."""
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(429))
    transport.queue_error(_http_error(429))
    transport.queue({"id": "ok"})
    assert client._request("GET", "/items") == {"id": "ok"}
    assert transport.sleeps == [1, 2]


def test_request_429_exhausts_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    for _ in range(6):
        transport.queue_error(_http_error(429, retry_after="0"))
    with pytest.raises(MiroAPIError) as exc:
        client._request("GET", "/items")
    assert exc.value.status == 429
    assert exc.value.body == "exhausted retries"
    assert len(transport.requests) == 6  # ровно 6 попыток (range(6))


# ── list_frames ─────────────────────────────────────────────────────────────────


def test_list_frames_parses_and_filters_non_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue(
        {
            "data": [
                {
                    "id": "f1",
                    "type": "frame",
                    "position": {"x": 100, "y": 200},
                    "geometry": {"width": 300, "height": 150},
                    "data": {"title": "Frame One"},
                },
                {"id": "s1", "type": "shape"},  # не frame → отброшен
                {"id": "f2", "type": "frame"},  # без position/geometry/data → дефолты
            ]
        }
    )
    frames = client.list_frames()
    assert [f.id for f in frames] == ["f1", "f2"]
    f1 = frames[0]
    assert (f1.x, f1.y, f1.w, f1.h, f1.title) == (100.0, 200.0, 300.0, 150.0, "Frame One")
    f2 = frames[1]
    assert (f2.x, f2.y, f2.w, f2.h, f2.title) == (0.0, 0.0, 0.0, 0.0, "")
    # query-строка содержит limit и type=frame.
    assert transport.requests[0].full_url == f"{BASE}/items?limit=50&type=frame"


def test_list_frames_paginates_until_no_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "f1", "type": "frame"}], "cursor": "c1"})
    transport.queue({"data": [{"id": "f2", "type": "frame"}]})  # cursor отсутствует → стоп
    frames = client.list_frames()
    assert [f.id for f in frames] == ["f1", "f2"]
    assert len(transport.requests) == 2
    assert "cursor=c1" in transport.requests[1].full_url


def test_list_frames_empty_data(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    assert client.list_frames() == []


def test_list_frames_missing_data_key(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({})  # ни data, ни cursor
    assert client.list_frames() == []
    assert len(transport.requests) == 1


# ── find_frame_by_title / rightmost_frame_edge ─────────────────────────────────


def test_find_frame_by_title_found(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "f1", "type": "frame", "data": {"title": "Target"}}]})
    found = client.find_frame_by_title("Target")
    assert found is not None
    assert found.id == "f1"


def test_find_frame_by_title_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "f1", "type": "frame", "data": {"title": "Other"}}]})
    assert client.find_frame_by_title("Nope") is None


def test_rightmost_frame_edge_computes_max_and_avg(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue(
        {
            "data": [
                {
                    "id": "f1",
                    "type": "frame",
                    "position": {"x": 0, "y": 100},
                    "geometry": {"width": 200, "height": 50},
                },
                {
                    "id": "f2",
                    "type": "frame",
                    "position": {"x": 1000, "y": 300},
                    "geometry": {"width": 400, "height": 50},
                },
            ]
        }
    )
    right, avg_y = client.rightmost_frame_edge()
    assert right == 1200.0  # max(0+200/2, 1000+400/2)
    assert avg_y == 200.0  # (100+300)/2


def test_rightmost_frame_edge_no_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    assert client.rightmost_frame_edge() == (0.0, 0.0)


# ── unlock_item ─────────────────────────────────────────────────────────────────


def test_unlock_item_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({})
    client.unlock_item("i1")
    req = transport.requests[0]
    assert req.get_method() == "PATCH"
    assert req.full_url == f"{BASE}/items/i1"
    assert _body(req) == {"locked": False}


def test_unlock_item_swallows_404(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(404))
    client.unlock_item("i1")  # не бросает


def test_unlock_item_swallows_400(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(400))
    client.unlock_item("i1")  # не бросает (PATCH не поддержан на типе)


def test_unlock_item_reraises_other_status(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue_error(_http_error(500))
    with pytest.raises(MiroAPIError):
        client.unlock_item("i1")


# ── delete_frame: children + frame ──────────────────────────────────────────────


def test_delete_frame_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})  # _iter_children
    transport.queue({})  # DELETE /items/i1
    transport.queue({})  # DELETE /frames/F
    client.delete_frame("F")
    reqs = transport.requests
    assert reqs[0].get_method() == "GET"
    assert "parent_item_id=F" in reqs[0].full_url
    assert (reqs[1].get_method(), reqs[1].full_url) == ("DELETE", f"{BASE}/items/i1")
    assert (reqs[2].get_method(), reqs[2].full_url) == ("DELETE", f"{BASE}/frames/F")


def test_delete_frame_iter_children_paginates(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}], "cursor": "c1"})
    transport.queue({"data": [{"id": "i2", "type": "text"}]})  # cursor пуст → стоп
    transport.queue({})  # DELETE /items/i1
    transport.queue({})  # DELETE /items/i2
    transport.queue({})  # DELETE /frames/F
    client.delete_frame("F")
    deleted = [r.full_url for r in transport.requests if r.get_method() == "DELETE"]
    assert deleted == [f"{BASE}/items/i1", f"{BASE}/items/i2", f"{BASE}/frames/F"]
    assert "cursor=c1" in transport.requests[1].full_url


def test_delete_frame_child_404_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(404))  # DELETE /items/i1 → continue
    transport.queue({})  # DELETE /frames/F
    client.delete_frame("F")
    assert len(transport.requests) == 3


def test_delete_frame_child_locked_unlock_then_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(400, "Item is locked"))  # DELETE /items/i1
    transport.queue({})  # PATCH /items/i1 (unlock)
    transport.queue({})  # retry DELETE /items/i1
    transport.queue({})  # DELETE /frames/F
    client.delete_frame("F")
    assert len(transport.requests) == 5
    unlock = transport.requests[2]
    assert unlock.get_method() == "PATCH"
    assert unlock.full_url == f"{BASE}/items/i1"
    assert _body(unlock) == {"locked": False}


def test_delete_frame_child_locked_retry_404_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(400, "locked"))  # DELETE /items/i1
    transport.queue({})  # PATCH unlock
    transport.queue_error(_http_error(404))  # retry DELETE → 404 → проглот
    transport.queue({})  # DELETE /frames/F
    client.delete_frame("F")
    assert len(transport.requests) == 5


def test_delete_frame_child_locked_retry_other_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(400, "locked"))  # DELETE /items/i1
    transport.queue({})  # PATCH unlock
    transport.queue_error(_http_error(500))  # retry DELETE → не-404 → raise
    with pytest.raises(MiroAPIError) as exc:
        client.delete_frame("F")
    assert exc.value.status == 500


def test_delete_frame_child_400_not_locked_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """400 без 'locked' в теле не разлочивается — пробрасывается наружу."""
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(400, "bad request"))
    with pytest.raises(MiroAPIError) as exc:
        client.delete_frame("F")
    assert exc.value.status == 400


def test_delete_frame_child_500_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": [{"id": "i1", "type": "shape"}]})
    transport.queue_error(_http_error(500))
    with pytest.raises(MiroAPIError):
        client.delete_frame("F")


def test_delete_frame_frame_404_returns(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})  # нет children
    transport.queue_error(_http_error(404))  # DELETE /frames/F → 404 → return
    client.delete_frame("F")  # без исключения
    assert len(transport.requests) == 2


def test_delete_frame_frame_locked_unlock_then_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    transport.queue_error(_http_error(400, "frame is locked"))  # DELETE /frames/F
    transport.queue({})  # PATCH /items/F (unlock)
    transport.queue({})  # retry DELETE /frames/F
    client.delete_frame("F")
    unlock = transport.requests[2]
    assert unlock.get_method() == "PATCH"
    assert unlock.full_url == f"{BASE}/items/F"  # unlock_item бьёт по /items/{id}


def test_delete_frame_frame_locked_retry_404_returns(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    transport.queue_error(_http_error(400, "locked"))  # DELETE /frames/F
    transport.queue({})  # PATCH unlock
    transport.queue_error(_http_error(404))  # retry DELETE → 404 → return
    client.delete_frame("F")
    assert len(transport.requests) == 4


def test_delete_frame_frame_locked_retry_other_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    transport.queue_error(_http_error(400, "locked"))  # DELETE /frames/F
    transport.queue({})  # PATCH unlock
    transport.queue_error(_http_error(500))  # retry DELETE → не-404 → raise
    with pytest.raises(MiroAPIError) as exc:
        client.delete_frame("F")
    assert exc.value.status == 500


def test_delete_frame_frame_other_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"data": []})
    transport.queue_error(_http_error(500))  # DELETE /frames/F → raise
    with pytest.raises(MiroAPIError):
        client.delete_frame("F")


# ── _delete_endpoint_for (static) ──────────────────────────────────────────────


def test_delete_endpoint_for_always_items() -> None:
    assert MiroClient._delete_endpoint_for("shape") == "/items"
    assert MiroClient._delete_endpoint_for("connector") == "/items"


# ── create_frame / create_shape / create_card / create_text ────────────────────


def test_create_frame_builds_body_and_returns_frameref(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "fr1"})
    fr = client.create_frame(title="T", x=10, y=20, width=100, height=50)
    assert isinstance(fr, FrameRef)
    assert (fr.id, fr.title, fr.x, fr.y, fr.w, fr.h) == ("fr1", "T", 10, 20, 100, 50)
    req = transport.requests[0]
    assert req.get_method() == "POST"
    assert req.full_url == f"{BASE}/frames"
    body = _body(req)
    assert isinstance(body, dict)
    assert body["data"] == {"title": "T", "format": "custom", "type": "freeform"}
    assert body["position"] == {"x": 10, "y": 20}
    assert body["geometry"] == {"width": 100, "height": 50}


def test_create_shape_clamps_geometry_and_returns_id(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "sh1"})
    sid = client.create_shape(
        parent_id="frame1",
        kind="rectangle",
        content_html="<p>hi</p>",
        x=5,
        y=6,
        width=10,  # < 60 → клампится
        height=5,  # < 40 → клампится
    )
    assert sid == "sh1"
    body = _body(transport.requests[0])
    assert isinstance(body, dict)
    assert body["data"] == {"shape": "rectangle", "content": "<p>hi</p>"}
    assert body["geometry"] == {"width": 60, "height": 40}
    assert body["parent"] == {"id": "frame1"}
    assert body["position"] == {"x": 5, "y": 6}
    assert transport.requests[0].full_url == f"{BASE}/shapes"


def test_create_card_clamps_min_width(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "cd1"})
    cid = client.create_card(
        parent_id="frame1",
        title="Card",
        description="<p>d</p>",
        x=1,
        y=2,
        width=10,  # < 256 → клампится
        height=5,  # < 40 → клампится
    )
    assert cid == "cd1"
    body = _body(transport.requests[0])
    assert isinstance(body, dict)
    assert body["data"] == {"title": "Card", "description": "<p>d</p>"}
    assert body["style"] == {"cardTheme": "#2d9bf0"}  # дефолтная тема
    assert body["geometry"] == {"width": 256, "height": 40}
    assert transport.requests[0].full_url == f"{BASE}/cards"


def test_create_text_clamps_min_width(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "tx1"})
    tid = client.create_text(parent_id="frame1", content_html="<p>t</p>", x=3, y=4, width=10)
    assert tid == "tx1"
    body = _body(transport.requests[0])
    assert isinstance(body, dict)
    assert body["data"] == {"content": "<p>t</p>"}
    assert body["geometry"] == {"width": 200}  # клампится до минимума, без height
    assert body["parent"] == {"id": "frame1"}
    assert transport.requests[0].full_url == f"{BASE}/texts"


# ── create_connector ────────────────────────────────────────────────────────────


def test_create_connector_minimal_no_snap_no_label(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "conn1"})
    cid = client.create_connector(src_id="a", dst_id="b")
    assert cid == "conn1"
    body = _body(transport.requests[0])
    assert isinstance(body, dict)
    assert body["startItem"] == {"id": "a"}
    assert body["endItem"] == {"id": "b"}
    assert body["shape"] == "elbowed"  # дефолт
    assert "captions" not in body  # без label секции captions нет
    assert transport.requests[0].full_url == f"{BASE}/connectors"


def test_create_connector_with_snaps_and_label(monkeypatch: pytest.MonkeyPatch) -> None:
    client, transport = _make_client(monkeypatch)
    transport.queue({"id": "conn2"})
    cid = client.create_connector(
        src_id="a",
        dst_id="b",
        label="A→B",
        shape="curved",
        snap_start="top",
        snap_end="bottom",
    )
    assert cid == "conn2"
    body = _body(transport.requests[0])
    assert isinstance(body, dict)
    assert body["startItem"] == {"id": "a", "snapTo": "top"}
    assert body["endItem"] == {"id": "b", "snapTo": "bottom"}
    assert body["shape"] == "curved"
    assert body["captions"] == [{"content": "A→B"}]


# ── MiroAPIError ────────────────────────────────────────────────────────────────


def test_miro_api_error_attrs_and_truncated_message() -> None:
    err = MiroAPIError("POST", "/shapes", 500, "x" * 400)
    assert (err.method, err.path, err.status) == ("POST", "/shapes", 500)
    assert err.body == "x" * 400  # тело хранится целиком
    text = str(err)
    assert text.startswith("miro POST /shapes -> 500: ")
    # в текст сообщения тело обрезано до 300 символов.
    assert "x" * 300 in text
    assert "x" * 301 not in text
