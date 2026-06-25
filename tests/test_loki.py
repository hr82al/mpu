"""Тесты `mpu/lib/loki.py` — без сетевых вызовов через httpx.MockTransport."""
# pyright: reportPrivateUsage=false

import httpx
import pytest

from mpu.lib import loki


def _install_transport(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport) -> None:
    """Подменяет `httpx.Client` в `loki`, подсовывая MockTransport.

    `query_range` сам конструирует `httpx.Client(base_url=..., timeout=...,
    trust_env=False)`, поэтому перехватываем на уровне конструктора и добавляем
    транспорт — `base_url`/params/`raise_for_status` остаются настоящими.
    """
    real_client = httpx.Client

    def fake_client(*, base_url: str, timeout: float, trust_env: bool = False) -> httpx.Client:
        _ = trust_env
        return real_client(base_url=base_url, timeout=timeout, transport=transport)

    monkeypatch.setattr(loki.httpx, "Client", fake_client)


def _ok_response(streams: list[object]) -> dict[str, object]:
    """Минимальный валидный ответ Loki `query_range`."""
    return {"status": "success", "data": {"resultType": "streams", "result": streams}}


# --------------------------------------------------------------------------- #
# query_range — построение запроса                                            #
# --------------------------------------------------------------------------- #


def test_query_range_builds_request(monkeypatch: pytest.MonkeyPatch) -> None:
    """URL, метод и все query-параметры собираются корректно."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=_ok_response([]))

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    loki.query_range(
        base_url="http://loki.local:3100",
        logql='{app="api"}',
        start_ns=1000,
        end_ns=2000,
        limit=500,
        direction="forward",
    )

    assert captured["method"] == "GET"
    url = captured["url"]
    assert isinstance(url, str)
    assert url.startswith("http://loki.local:3100/loki/api/v1/query_range")
    params = captured["params"]
    assert isinstance(params, dict)
    assert params == {
        "query": '{app="api"}',
        "start": "1000",
        "end": "2000",
        "limit": "500",
        "direction": "forward",
    }


def test_query_range_default_direction_backward(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без явного `direction` — backward (tail-семантика 'сначала свежие')."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=_ok_response([]))

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    loki.query_range(
        base_url="http://loki.local:3100",
        logql="{}",
        start_ns=0,
        end_ns=1,
        limit=10,
    )

    params = captured["params"]
    assert isinstance(params, dict)
    assert params["direction"] == "backward"


# --------------------------------------------------------------------------- #
# query_range — парсинг ответа                                                #
# --------------------------------------------------------------------------- #


def test_query_range_parses_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    """Несколько streams с несколькими values ровняются в плоский список."""
    streams: list[object] = [
        {
            "stream": {"app": "api", "host": "sl-1"},
            "values": [
                ["1700000000000000001", "line-a"],
                ["1700000000000000002", "line-b"],
            ],
        },
        {
            "stream": {"app": "worker"},
            "values": [["1700000000000000003", "line-c"]],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json=_ok_response(streams))

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    entries = loki.query_range(
        base_url="http://loki.local:3100",
        logql="{}",
        start_ns=0,
        end_ns=1,
        limit=10,
    )

    assert entries == [
        loki.LogEntry(
            ts_ns=1700000000000000001,
            line="line-a",
            labels={"app": "api", "host": "sl-1"},
        ),
        loki.LogEntry(
            ts_ns=1700000000000000002,
            line="line-b",
            labels={"app": "api", "host": "sl-1"},
        ),
        loki.LogEntry(
            ts_ns=1700000000000000003,
            line="line-c",
            labels={"app": "worker"},
        ),
    ]


def test_query_range_empty_result(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой `result` → пустой список, без ошибок."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json=_ok_response([]))

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    assert (
        loki.query_range(
            base_url="http://loki.local:3100",
            logql="{}",
            start_ns=0,
            end_ns=1,
            limit=10,
        )
        == []
    )


def test_query_range_raises_on_non_200(monkeypatch: pytest.MonkeyPatch) -> None:
    """Не-2xx → `raise_for_status` бросает HTTPStatusError."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(400, json={"error": "parse error"})

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        loki.query_range(
            base_url="http://loki.local:3100",
            logql="{bad",
            start_ns=0,
            end_ns=1,
            limit=10,
        )


def test_query_range_raises_on_500(monkeypatch: pytest.MonkeyPatch) -> None:
    """5xx тоже поднимается наружу (caller сам решает что делать)."""

    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500, text="boom")

    _install_transport(monkeypatch, httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        loki.query_range(
            base_url="http://loki.local:3100",
            logql="{}",
            start_ns=0,
            end_ns=1,
            limit=10,
        )


# --------------------------------------------------------------------------- #
# _parse_query_range_response — устойчивость к мусору                          #
# --------------------------------------------------------------------------- #


def test_parse_non_dict_returns_empty() -> None:
    """Верхний уровень — не dict → []."""
    assert loki._parse_query_range_response([]) == []
    assert loki._parse_query_range_response("garbage") == []
    assert loki._parse_query_range_response(None) == []


def test_parse_missing_data_key_returns_empty() -> None:
    """Нет ключа `data` (или он не dict) → []."""
    assert loki._parse_query_range_response({"status": "success"}) == []
    assert loki._parse_query_range_response({"data": "nope"}) == []
    assert loki._parse_query_range_response({"data": ["x"]}) == []


def test_parse_result_not_list_returns_empty() -> None:
    """`data.result` не list → []."""
    assert loki._parse_query_range_response({"data": {"result": "nope"}}) == []
    assert loki._parse_query_range_response({"data": {}}) == []


def test_parse_skips_non_dict_stream() -> None:
    """Элемент result не dict — пропускается, остальные парсятся."""
    data = {
        "data": {
            "result": [
                "not-a-stream",
                {"stream": {"a": "b"}, "values": [["1", "ok"]]},
            ]
        }
    }
    assert loki._parse_query_range_response(data) == [
        loki.LogEntry(ts_ns=1, line="ok", labels={"a": "b"})
    ]


def test_parse_labels_filters_non_string_pairs() -> None:
    """В `stream` нестроковые ключи/значения отбрасываются."""
    data = {
        "data": {
            "result": [
                {
                    "stream": {"app": "api", "num": 5, 7: "x", "ok": "yes"},
                    "values": [["10", "ln"]],
                }
            ]
        }
    }
    entries = loki._parse_query_range_response(data)
    assert entries == [loki.LogEntry(ts_ns=10, line="ln", labels={"app": "api", "ok": "yes"})]


def test_parse_labels_not_dict_yields_empty_labels() -> None:
    """`stream` не dict → labels пустые, но запись остаётся."""
    data = {"data": {"result": [{"stream": "broken", "values": [["10", "ln"]]}]}}
    assert loki._parse_query_range_response(data) == [loki.LogEntry(ts_ns=10, line="ln", labels={})]


def test_parse_missing_stream_key_yields_empty_labels() -> None:
    """Нет ключа `stream` вовсе → labels пустые."""
    data = {"data": {"result": [{"values": [["10", "ln"]]}]}}
    assert loki._parse_query_range_response(data) == [loki.LogEntry(ts_ns=10, line="ln", labels={})]


def test_parse_values_not_list_skips_stream() -> None:
    """`values` не list → stream пропускается целиком."""
    data = {"data": {"result": [{"stream": {"a": "b"}, "values": "nope"}]}}
    assert loki._parse_query_range_response(data) == []


def test_parse_missing_values_key_skips_stream() -> None:
    """Нет ключа `values` → stream пропускается."""
    data = {"data": {"result": [{"stream": {"a": "b"}}]}}
    assert loki._parse_query_range_response(data) == []


def test_parse_skips_malformed_pairs() -> None:
    """Пары не-list / короткие / нестроковые / непарсимые ts — пропускаются."""
    data: dict[str, object] = {
        "data": {
            "result": [
                {
                    "stream": {},
                    "values": [
                        "not-a-list",
                        ["only-one"],
                        [123, "line"],
                        ["123", 456],
                        ["not-int", "line"],
                        ["999", "good"],
                    ],
                }
            ]
        }
    }
    assert loki._parse_query_range_response(data) == [
        loki.LogEntry(ts_ns=999, line="good", labels={})
    ]


def test_parse_extra_pair_elements_ignored() -> None:
    """Пара длиннее 2 элементов — берём первые два, остальное игнорируем."""
    data: dict[str, object] = {
        "data": {"result": [{"stream": {}, "values": [["5", "ln", {"meta": "extra"}]]}]}
    }
    assert loki._parse_query_range_response(data) == [loki.LogEntry(ts_ns=5, line="ln", labels={})]


def test_logentry_is_frozen() -> None:
    """LogEntry неизменяем (frozen dataclass) — защита от мутаций caller'ом."""
    entry = loki.LogEntry(ts_ns=1, line="x", labels={})
    with pytest.raises((AttributeError, TypeError)):
        entry.ts_ns = 2  # type: ignore[misc]  # проверяем именно запрет записи
