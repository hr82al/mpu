"""Тесты `lib/sheet_api.py::WebappClient` — retry/quota/error handling.

Портировано из new-mpu/tests/webapp.test.ts и retry.test.ts. Сетевые вызовы
мокаются через `httpx.MockTransport` (передаётся в WebappClient.transport).
"""

from __future__ import annotations

import json

import httpx
import pytest

from mpu.lib.sheet_api import SheetApiError, WebappClient


def _ok(result: object = None) -> dict[str, object]:
    return {
        "success": True,
        "result": result if result is not None else {},
        "action": "spreadsheets/values/batchGet",
    }


def _make_client(
    transport: httpx.MockTransport, *, max_retries: int = 3
) -> tuple[WebappClient, list[float]]:
    sleeps: list[float] = []
    client = WebappClient(
        url="https://example.test/exec",
        timeout_seconds=5.0,
        max_retries=max_retries,
        quota_delay_seconds=0.001,
        _sleeper=sleeps.append,
        _transport=transport,
    )
    return client, sleeps


def test_success_returns_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok({"values": [[1]]}))

    client, _ = _make_client(httpx.MockTransport(handler))
    assert client.call("spreadsheets/values/batchGet", ssId="X", ranges=["A1"]) == {
        "values": [[1]]
    }


def test_5xx_retried_then_success() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, text="oops")
        return httpx.Response(200, json=_ok({"ok": 1}))

    client, _ = _make_client(httpx.MockTransport(handler))
    assert client.call("spreadsheets/values/batchGet", ssId="X") == {"ok": 1}
    assert calls["n"] == 2


def test_4xx_fatal_not_retried() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, text="unauth")

    client, _ = _make_client(httpx.MockTransport(handler))
    with pytest.raises(SheetApiError) as exc:
        client.call("x")
    assert exc.value.status == 401
    assert calls["n"] == 1


def test_error_contains_action_status_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="fatal-body-c")

    client, _ = _make_client(httpx.MockTransport(handler), max_retries=2)
    with pytest.raises(SheetApiError) as exc:
        client.call("spreadsheets/values/batchGet", ssId="SHEET_X")
    err = exc.value
    assert err.action == "spreadsheets/values/batchGet"
    assert err.status == 500
    assert "fatal-body-c" in (err.body or "")
    assert "spreadsheets/values/batchGet" in str(err)


def test_quota_in_app_error_retries_with_quota_delay() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(200, json={"success": False, "error": "Quota exceeded"})
        return httpx.Response(200, json=_ok({"ok": True}))

    client, sleeps = _make_client(httpx.MockTransport(handler))
    assert client.call("x") == {"ok": True}
    assert sleeps[0] == pytest.approx(0.001)


def test_app_error_non_quota_is_fatal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"success": False, "error": 'Sheet "WAT" not found'}
        )

    client, _ = _make_client(httpx.MockTransport(handler))
    with pytest.raises(SheetApiError) as exc:
        client.call("spreadsheets/values/batchGet", ssId="X")
    assert "WAT" in str(exc.value)


def test_network_error_retried() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("ECONNRESET")
        return httpx.Response(200, json=_ok(1))

    client, _ = _make_client(httpx.MockTransport(handler))
    # call() wraps non-dict result в {value: result}.
    assert client.call("x") == {"value": 1}
    assert calls["n"] == 2


def test_max_retries_exhausted() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client, _ = _make_client(httpx.MockTransport(handler), max_retries=2)
    with pytest.raises(SheetApiError) as exc:
        client.call("spreadsheets/values/batchGet", ssId="X")
    assert exc.value.status == 500


def test_404_retried_then_success() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= 2:
            return httpx.Response(404, text="<html>Страница не найдена</html>")
        return httpx.Response(200, json=_ok({"ok": True}))

    client, sleeps = _make_client(httpx.MockTransport(handler))
    client.not_found_delay_seconds = 10.0
    assert client.call("spreadsheets/values/batchGet", ssId="X") == {"ok": True}
    assert calls["n"] == 3
    assert sleeps[:2] == [10.0, 10.0]


def test_404_exhausted_then_fatal() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(404, text="<html>Страница не найдена</html>")

    client, sleeps = _make_client(httpx.MockTransport(handler))
    client.not_found_delay_seconds = 10.0
    with pytest.raises(SheetApiError) as exc:
        client.call("spreadsheets/values/batchGet", ssId="X")
    assert exc.value.status == 404
    # 3 retries (paused 10s each) + 1 final fatal attempt = 4 requests.
    assert calls["n"] == 4
    assert sleeps == [10.0, 10.0, 10.0]


def test_429_treated_as_quota() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, text="rate limited")
        return httpx.Response(200, json=_ok({"ok": True}))

    client, sleeps = _make_client(httpx.MockTransport(handler))
    assert client.call("x") == {"ok": True}
    assert sleeps[0] == pytest.approx(0.001)


def test_batch_get_payload_shape() -> None:
    captured: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json=_ok({"valueRanges": []}))

    client, _ = _make_client(httpx.MockTransport(handler))
    client.batch_get("SS_X", ["Sheet1!A1:B2"], value_render="FORMULA")
    body = captured[0]
    assert body["action"] == "spreadsheets/values/batchGet"
    assert body["ssId"] == "SS_X"
    assert body["ranges"] == ["Sheet1!A1:B2"]
    assert body["valueRenderOption"] == "FORMULA"


def test_batch_update_payload_shape() -> None:
    captured: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json=_ok({"responses": []}))

    client, _ = _make_client(httpx.MockTransport(handler))
    client.batch_update(
        "SS_X", [{"range": "Sheet1!A1", "values": [["hi"]]}], value_input_option="RAW"
    )
    body = captured[0]
    assert body["action"] == "spreadsheets/values/batchUpdate"
    assert body["ssId"] == "SS_X"
    rb = body["requestBody"]
    assert isinstance(rb, dict)
    assert rb["valueInputOption"] == "RAW"
    assert rb["data"][0]["range"] == "Sheet1!A1"


def test_get_metadata_action() -> None:
    captured: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(
            200, json=_ok({"sheets": [{"properties": {"title": "Sheet1"}}]})
        )

    client, _ = _make_client(httpx.MockTransport(handler))
    result = client.get_metadata("SS_X")
    assert captured[0]["action"] == "spreadsheets/get"
    assert captured[0]["ssId"] == "SS_X"
    assert result["sheets"][0]["properties"]["title"] == "Sheet1"
