"""Тесты CLI `mpu sheet` (mpu.commands.sheet).

Драйвим subcommand'ы через `typer.testing.CliRunner`, мокаем именованные швы:
  - `store.DB_PATH` → tmp sqlite (bootstrap через фикстуру `bootstrap_db`);
  - `WebappClient.from_env` → fake / scripted httpx.MockTransport (нет сети);
  - `sheet_cmd.get_ranges` / `sheet_cmd.get_metadata` — где нужен прямой стаб;
  - `slapi.SlApi.from_env` — для `sync`;
  - `webbrowser.open` — для `open`.

Проверяем happy-path, error/exit-пути, пустой/garbage-вход и идемпотентность.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from mpu.commands import sheet as sheet_cmd
from mpu.lib import env, slapi, store
from mpu.lib.sheet_api import SheetApiError, WebappClient
from mpu.lib.sheet_cache import FetchResult, TabInfo

runner = CliRunner()

# Валидный (20+ символов) spreadsheet ID — резолвится через ID_RE, без БД.
SS = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


# ────────────────────────────────────────────────────────────────────────────
# Фикстуры
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bootstrap_db: Callable[[Path | str], None],
) -> Iterator[sqlite3.Connection]:
    """Tmp SQLite-кэш под `store.DB_PATH` + изоляция от реального `.env`."""
    db_path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db_path)
    # Не читать ~/.config/mpu/.env: env._loaded=True гасит load(); MPU_SS вон.
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("MPU_SS", raising=False)
    bootstrap_db(db_path)
    conn = store.open_store(db_path)
    yield conn
    conn.close()


def _patch_from_env(monkeypatch: pytest.MonkeyPatch, api: object) -> None:
    """Подменить `WebappClient.from_env()` → готовый (fake/scripted) клиент."""
    monkeypatch.setattr(WebappClient, "from_env", staticmethod(lambda: api))


def _noop_open(_url: str) -> None:
    """Заглушка `webbrowser.open` — ничего не делает."""
    return None


def _insert_ss(conn: sqlite3.Connection, ss_id: str, client_id: int, title: str) -> None:
    conn.execute(
        "INSERT INTO sl_spreadsheets "
        "(ss_id, client_id, title, template_name, is_active, server, synced_at) "
        "VALUES (?, ?, ?, ?, 1, ?, ?)",
        (ss_id, client_id, title, "tmpl", "sl-1", 100),
    )
    conn.commit()


# ────────────────────────────────────────────────────────────────────────────
# Fakes
# ────────────────────────────────────────────────────────────────────────────


class FakeApi:
    """Минимальный WebappClient-двойник: записывает вызовы, отдаёт scripted ответы."""

    def __init__(self) -> None:
        self.batch_update_calls: list[tuple[str, list[dict[str, Any]], str]] = []
        self.batch_update_resp: dict[str, Any] = {"spreadsheetId": SS, "responses": [{"ok": 1}]}
        self.batch_get_rows: list[list[Any]] = []
        self.spreadsheet_resp: dict[str, Any] = {"replies": [{"ok": 1}]}
        self.metadata_resp: dict[str, Any] = {
            "sheets": [{"properties": {"title": "Sheet1", "sheetId": 1}, "merges": []}]
        }

    def batch_update(
        self, ss_id: str, data: list[dict[str, Any]], *, value_input_option: str = "USER_ENTERED"
    ) -> dict[str, Any]:
        self.batch_update_calls.append((ss_id, data, value_input_option))
        return self.batch_update_resp

    def batch_get(
        self, ss_id: str, ranges: list[str], *, value_render: str = "UNFORMATTED_VALUE"
    ) -> dict[str, Any]:
        return {"valueRanges": [{"range": ranges[0], "values": self.batch_get_rows}]}

    def batch_update_spreadsheet(
        self, ss_id: str, requests: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return self.spreadsheet_resp

    def call(self, action: str, **payload: Any) -> dict[str, Any]:
        if action == "spreadsheets/get":
            return self.metadata_resp
        return {"valueRanges": [{"range": "Sheet1!A1:B2", "values": []}]}


class FakeSlApi:
    """SlApi-двойник для `sync`: отдаёт заранее заданный ответ либо бросает."""

    def __init__(self, response: object = None, *, error: slapi.SlApiError | None = None) -> None:
        self._response = response
        self._error = error

    def request(self, method: str, pathname: str, **_kw: Any) -> object:
        if self._error is not None:
            raise self._error
        return self._response


class _ScriptedTransport:
    """httpx.MockTransport handler: scripted metadata + batchGet (для cold/warm)."""

    def __init__(self) -> None:
        self.metadata_response: dict[str, Any] | None = None
        self.batch_get_responses: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body: dict[str, Any] = json.loads(request.content)
        self.calls.append(body)
        action = body["action"]
        if action == "spreadsheets/get":
            assert self.metadata_response is not None, "metadata not scripted"
            return httpx.Response(200, json={"success": True, "result": self.metadata_response})
        if action == "spreadsheets/values/batchGet":
            assert self.batch_get_responses, "batchGet not scripted"
            return httpx.Response(
                200, json={"success": True, "result": self.batch_get_responses.pop(0)}
            )
        return httpx.Response(500, text=f"unhandled action: {action}")


def _scripted_client(transport: _ScriptedTransport) -> WebappClient:
    return WebappClient(
        url="https://example.test/exec",
        timeout_seconds=5.0,
        max_retries=1,
        quota_delay_seconds=0.001,
        _sleeper=lambda _: None,
        _transport=httpx.MockTransport(transport.handler),
    )


def _fake_get_ranges(
    results: list[FetchResult],
) -> Callable[..., list[FetchResult]]:
    def _f(*_a: object, **_kw: object) -> list[FetchResult]:
        return results

    return _f


def _fake_get_metadata(
    tabs: list[TabInfo],
) -> Callable[..., list[TabInfo]]:
    def _f(*_a: object, **_kw: object) -> list[TabInfo]:
        return tabs

    return _f


# ────────────────────────────────────────────────────────────────────────────
# resolve
# ────────────────────────────────────────────────────────────────────────────


def test_resolve_by_id(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["resolve", "-s", SS])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["ss_id"] == SS
    assert out["source"] == "flag"
    assert out["kind"] == "id"
    assert out["original_input"] == SS


def test_resolve_by_client_id(db: sqlite3.Connection) -> None:
    _insert_ss(db, "ssClient", 736, "Клиент 736")
    res = runner.invoke(sheet_cmd.app, ["resolve", "-s", "736"])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["ss_id"] == "ssClient"
    assert out["kind"] == "client_id"


def test_resolve_by_alias(db: sqlite3.Connection) -> None:
    runner.invoke(sheet_cmd.app, ["alias", "add", "main", SS])
    res = runner.invoke(sheet_cmd.app, ["resolve", "-s", "main"])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["ss_id"] == SS
    assert out["kind"] == "alias"


def test_resolve_missing_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["resolve"])
    assert res.exit_code == 2
    assert "Spreadsheet" in res.stderr


def test_resolve_ambiguous_exits_2(db: sqlite3.Connection) -> None:
    _insert_ss(db, "ssA", 10, "Тортуга main")
    _insert_ss(db, "ssB", 20, "Тортуга side")
    res = runner.invoke(sheet_cmd.app, ["resolve", "-s", "Тортуга"])
    assert res.exit_code == 2
    assert "Тортуга" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# get — cold/warm cache (интеграция через MockTransport)
# ────────────────────────────────────────────────────────────────────────────


def _meta_3x3() -> dict[str, Any]:
    return {
        "spreadsheetId": SS,
        "sheets": [
            {
                "properties": {
                    "title": "Sheet1",
                    "sheetId": 1,
                    "index": 0,
                    "gridProperties": {"rowCount": 3, "columnCount": 3},
                }
            }
        ],
    }


def _values(range_str: str, values: list[list[Any]]) -> dict[str, Any]:
    return {
        "spreadsheetId": SS,
        "valueRanges": [{"range": range_str, "values": values, "majorDimension": "ROWS"}],
    }


def test_get_cold_then_warm(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    transport = _ScriptedTransport()
    transport.metadata_response = _meta_3x3()
    transport.batch_get_responses = [
        _values("Sheet1!A1:C3", [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]]),
        _values("Sheet1!A1:C3", [["", "", ""], ["", "", ""], ["", "", ""]]),
    ]
    _patch_from_env(monkeypatch, _scripted_client(transport))

    # COLD — fromCache False, реальный fetch.
    cold = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1:B2", "-s", SS])
    assert cold.exit_code == 0, cold.stderr
    cold_out: dict[str, Any] = json.loads(cold.stdout)
    assert cold_out["spreadsheetId"] == SS
    vr = cold_out["valueRanges"][0]
    assert vr["fromCache"] is False
    assert vr["values"] == [["a", "b"], ["d", "e"]]

    # WARM — обнуляем scripted, второй вызов должен бить только в кэш.
    transport.batch_get_responses = []
    transport.calls = []
    warm = runner.invoke(sheet_cmd.app, ["get", "Sheet1!B2:C3", "-s", SS])
    assert warm.exit_code == 0, warm.stderr
    warm_out: dict[str, Any] = json.loads(warm.stdout)
    assert warm_out["valueRanges"][0]["fromCache"] is True
    assert warm_out["valueRanges"][0]["values"] == [["e", "f"], ["h", "i"]]
    assert transport.calls == []  # ни одного сетевого вызова


def test_get_invalid_render_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS, "--render", "bogus"])
    assert res.exit_code == 2
    assert "--render must be one of" in res.stderr


def test_get_no_ranges_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["get", "-s", SS])
    assert res.exit_code == 2
    assert "Usage: mpu sheet get" in res.stderr


def test_get_api_error_exits_1(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())

    def _boom(*_a: object, **_kw: object) -> list[FetchResult]:
        raise SheetApiError("upstream blew up")

    monkeypatch.setattr(sheet_cmd, "get_ranges", _boom)
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS])
    assert res.exit_code == 1
    assert "upstream blew up" in res.stderr


def test_get_json_omits_none_layers(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1",
                    values=[["v"]],
                    formulas=None,
                    formatted=None,
                    from_cache=False,
                )
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS])
    assert res.exit_code == 0, res.stderr
    item: dict[str, Any] = json.loads(res.stdout)["valueRanges"][0]
    assert item["values"] == [["v"]]
    # Семантика: None-слои не выставляются как ключи.
    assert "formulas" not in item
    assert "formatted" not in item
    assert item["fromCache"] is False


def test_get_raw_single_cell_no_newline(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1",
                    values=[["hello"]],
                    formulas=None,
                    formatted=None,
                    from_cache=False,
                )
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS, "--raw"])
    assert res.exit_code == 0, res.stderr
    assert res.stdout == "hello"


def test_get_tsv_blank_line_between_ranges(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1:B1",
                    values=[["a", "b"]],
                    formulas=None,
                    formatted=None,
                    from_cache=False,
                ),
                FetchResult(
                    range="Sheet1!A2:B2",
                    values=[["c", "d"]],
                    formulas=None,
                    formatted=None,
                    from_cache=False,
                ),
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1:B1", "Sheet1!A2:B2", "-s", SS, "--tsv"])
    assert res.exit_code == 0, res.stderr
    assert res.stdout == "a\tb\n\nc\td\n"


def test_get_from_file_reads_ranges(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ranges_file = tmp_path / "ranges.txt"
    ranges_file.write_text("# comment\nSheet1!A1\n\nSheet1!B2\n")
    captured: dict[str, Any] = {}

    def _capture(*a: object, **_kw: object) -> list[FetchResult]:
        captured["refs"] = a[3]
        return [
            FetchResult(
                range="Sheet1!A1", values=[["x"]], formulas=None, formatted=None, from_cache=False
            )
        ]

    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_ranges", _capture)
    res = runner.invoke(sheet_cmd.app, ["get", "-s", SS, "--from", str(ranges_file)])
    assert res.exit_code == 0, res.stderr
    refs = captured["refs"]
    assert [r.tab for r in refs] == ["Sheet1", "Sheet1"]


# ────────────────────────────────────────────────────────────────────────────
# ls
# ────────────────────────────────────────────────────────────────────────────


def _tabs() -> list[TabInfo]:
    return [
        TabInfo(title="Sheet1", sheet_id=1, rows=100, cols=26, index=0),
        TabInfo(title="Чек-лист", sheet_id=2, rows=50, cols=10, index=1),
    ]


def test_ls_plain(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_metadata", _fake_get_metadata(_tabs()))
    res = runner.invoke(sheet_cmd.app, ["ls", "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert res.stdout.splitlines() == ["Sheet1", "Чек-лист"]


def test_ls_long(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_metadata", _fake_get_metadata(_tabs()))
    res = runner.invoke(sheet_cmd.app, ["ls", "-s", SS, "--long"])
    assert res.exit_code == 0, res.stderr
    assert "Sheet1\t100×26\tsheetId=1\tindex=0" in res.stdout


def test_ls_json(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_metadata", _fake_get_metadata(_tabs()))
    res = runner.invoke(sheet_cmd.app, ["ls", "-s", SS, "--json"])
    assert res.exit_code == 0, res.stderr
    arr: list[dict[str, Any]] = json.loads(res.stdout)
    assert [t["title"] for t in arr] == ["Sheet1", "Чек-лист"]
    assert arr[0]["sheet_id"] == 1


def test_ls_api_error_exits_1(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())

    def _boom(*_a: object, **_kw: object) -> list[TabInfo]:
        raise SheetApiError("metadata down")

    monkeypatch.setattr(sheet_cmd, "get_metadata", _boom)
    res = runner.invoke(sheet_cmd.app, ["ls", "-s", SS])
    assert res.exit_code == 1
    assert "metadata down" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# set — single / batch / json-stdin / errors
# ────────────────────────────────────────────────────────────────────────────


def test_set_single(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(sheet_cmd.app, ["set", "Sheet1!A1", "42", "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert len(api.batch_update_calls) == 1
    ss_id, data, opt = api.batch_update_calls[0]
    assert ss_id == SS
    assert opt == "USER_ENTERED"
    assert data[0]["range"] == "Sheet1!A1"
    assert data[0]["values"] == [["42"]]


def test_set_literal_uses_raw(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(sheet_cmd.app, ["set", "Sheet1!A1", "=SUM(B:B)", "-s", SS, "--literal"])
    assert res.exit_code == 0, res.stderr
    assert api.batch_update_calls[0][2] == "RAW"


def test_set_batch_from_file(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    batch = tmp_path / "batch.tsv"
    batch.write_text("# header\nSheet1!A1\t1\nSheet1!A2\t2\n")
    res = runner.invoke(sheet_cmd.app, ["set", "--from", str(batch), "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert len(api.batch_update_calls) == 1
    data = api.batch_update_calls[0][1]
    assert [d["range"] for d in data] == ["Sheet1!A1", "Sheet1!A2"]


def test_set_batch_missing_tab_exits_2(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    batch = tmp_path / "bad.tsv"
    batch.write_text("Sheet1!A1 no-tab-separator\n")
    res = runner.invoke(sheet_cmd.app, ["set", "--from", str(batch), "-s", SS])
    assert res.exit_code == 2
    assert "missing TAB" in res.stderr


def test_set_json_stdin(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(
        sheet_cmd.app,
        ["set", "-s", SS],
        input='[{"range": "Sheet1!A1", "value": "hi"}]',
    )
    assert res.exit_code == 0, res.stderr
    _ss_id, data, opt = api.batch_update_calls[0]
    assert opt == "RAW"
    assert data[0]["range"] == "Sheet1!A1"


def test_set_json_stdin_invalid_exits_2(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    res = runner.invoke(sheet_cmd.app, ["set", "-s", SS], input="not-json")
    assert res.exit_code == 2
    assert "невалидный JSON" in res.stderr


def test_set_api_error_exits_1(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    class _BoomApi(FakeApi):
        def batch_update(
            self,
            ss_id: str,
            data: list[dict[str, Any]],
            *,
            value_input_option: str = "USER_ENTERED",
        ) -> dict[str, Any]:
            raise SheetApiError("write rejected")

    _patch_from_env(monkeypatch, _BoomApi())
    res = runner.invoke(sheet_cmd.app, ["set", "Sheet1!A1", "1", "-s", SS])
    assert res.exit_code == 1
    assert "write rejected" in res.stderr


def test_set_invalidates_tab_cache(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    # Засеять кэш tab'а, затем set должен его сбросить.
    db.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES (?, ?, X'1f8b00', 3, ?)",
        (SS, "Sheet1", int(time.time())),
    )
    db.commit()
    _patch_from_env(monkeypatch, FakeApi())
    res = runner.invoke(sheet_cmd.app, ["set", "Sheet1!A1", "9", "-s", SS])
    assert res.exit_code == 0, res.stderr
    n = db.execute("SELECT COUNT(*) AS n FROM sheet_tabs WHERE ss_id = ?", (SS,)).fetchone()["n"]
    assert n == 0


# ────────────────────────────────────────────────────────────────────────────
# alias add / ls / rm
# ────────────────────────────────────────────────────────────────────────────


def test_alias_add_and_ls(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["alias", "add", "main", SS])
    assert res.exit_code == 0, res.stderr
    assert f"alias main → {SS}" in res.stdout
    res_ls = runner.invoke(sheet_cmd.app, ["alias", "ls"])
    assert res_ls.exit_code == 0, res_ls.stderr
    assert f"main\t{SS}" in res_ls.stdout


def test_alias_add_from_url(db: sqlite3.Connection) -> None:
    url = f"https://docs.google.com/spreadsheets/d/{SS}/edit#gid=0"
    res = runner.invoke(sheet_cmd.app, ["alias", "add", "fromurl", url])
    assert res.exit_code == 0, res.stderr
    assert f"alias fromurl → {SS}" in res.stdout


def test_alias_add_idempotent_update(db: sqlite3.Connection) -> None:
    other = "9ZyXwVuTsRqPoNmLkJiHgFeDcBa987654321"
    runner.invoke(sheet_cmd.app, ["alias", "add", "main", SS])
    res = runner.invoke(sheet_cmd.app, ["alias", "add", "main", other])
    assert res.exit_code == 0, res.stderr
    rows = db.execute("SELECT ss_id FROM sheet_aliases WHERE name = 'main'").fetchall()
    assert len(rows) == 1
    assert rows[0]["ss_id"] == other


def test_alias_add_bad_name_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["alias", "add", "bad name", SS])
    assert res.exit_code == 2
    assert "недопустимые символы" in res.stderr


def test_alias_add_bad_ssid_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["alias", "add", "ok", "short"])
    assert res.exit_code == 2
    assert "не похож на spreadsheet" in res.stderr


def test_alias_rm_existing(db: sqlite3.Connection) -> None:
    runner.invoke(sheet_cmd.app, ["alias", "add", "main", SS])
    res = runner.invoke(sheet_cmd.app, ["alias", "rm", "main"])
    assert res.exit_code == 0, res.stderr
    assert "removed alias main" in res.stdout


def test_alias_rm_missing_exits_1(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["alias", "rm", "nope"])
    assert res.exit_code == 1
    assert "not found" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# cache clear / info
# ────────────────────────────────────────────────────────────────────────────


def _seed_tab(conn: sqlite3.Connection, ss_id: str, tab: str) -> None:
    conn.execute(
        "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes, fetched_at) "
        "VALUES (?, ?, X'1f8b00', 2048, ?)",
        (ss_id, tab, int(time.time())),
    )
    conn.commit()


def test_cache_clear_all(db: sqlite3.Connection) -> None:
    _seed_tab(db, SS, "Sheet1")
    _seed_tab(db, "other", "Tab2")
    res = runner.invoke(sheet_cmd.app, ["cache", "clear"])
    assert res.exit_code == 0, res.stderr
    assert "cleared 2 tabs (whole cache)" in res.stdout
    n = db.execute("SELECT COUNT(*) AS n FROM sheet_tabs").fetchone()["n"]
    assert n == 0


def test_cache_clear_single(db: sqlite3.Connection) -> None:
    _seed_tab(db, SS, "Sheet1")
    _seed_tab(db, "other", "Tab2")
    res = runner.invoke(sheet_cmd.app, ["cache", "clear", "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert f"cleared 1 tabs for {SS}" in res.stdout
    rows = db.execute("SELECT ss_id FROM sheet_tabs").fetchall()
    assert [r["ss_id"] for r in rows] == ["other"]


def test_cache_info_empty(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["cache", "info"])
    assert res.exit_code == 0, res.stderr
    assert "total: 0 tabs" in res.stdout


def test_cache_info_with_tabs(db: sqlite3.Connection) -> None:
    _seed_tab(db, SS, "Sheet1")
    res = runner.invoke(sheet_cmd.app, ["cache", "info"])
    assert res.exit_code == 0, res.stderr
    assert "total: 1 tabs" in res.stdout
    assert SS in res.stdout


# ────────────────────────────────────────────────────────────────────────────
# sync
# ────────────────────────────────────────────────────────────────────────────


def test_sync_inserts_rows(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    # Намеренно неоднородный список: 2 валидные строки + строка без ss_id + не-dict.
    rows: list[Any] = [
        {"spreadsheet_id": "ss1", "client_id": 1, "title": "One", "server": "sl-1"},
        {"ss_id": "ss2", "client_id": 2, "title": "Two", "is_active": False, "server": "sl-2"},
        {"client_id": 3},  # без ss_id — пропускается
        "garbage",  # не dict — пропускается
    ]
    monkeypatch.setattr(slapi.SlApi, "from_env", staticmethod(lambda: FakeSlApi(rows)))
    res = runner.invoke(sheet_cmd.app, ["sync"])
    assert res.exit_code == 0, res.stderr
    assert "synced 4 spreadsheets" in res.stdout
    stored = db.execute("SELECT ss_id, is_active FROM sl_spreadsheets ORDER BY ss_id").fetchall()
    assert [r["ss_id"] for r in stored] == ["ss1", "ss2"]
    by_id = {r["ss_id"]: r["is_active"] for r in stored}
    assert by_id["ss1"] == 1
    assert by_id["ss2"] == 0


def test_sync_api_error_exits_1(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        slapi.SlApi,
        "from_env",
        staticmethod(lambda: FakeSlApi(error=slapi.SlApiError("sl-back down"))),
    )
    res = runner.invoke(sheet_cmd.app, ["sync"])
    assert res.exit_code == 1
    assert "sl-back down" in res.stderr


def test_sync_non_list_exits_1(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(slapi.SlApi, "from_env", staticmethod(lambda: FakeSlApi({"not": "a list"})))
    res = runner.invoke(sheet_cmd.app, ["sync"])
    assert res.exit_code == 1
    assert "ожидался list" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# open
# ────────────────────────────────────────────────────────────────────────────


def test_open_whole_spreadsheet(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(sheet_cmd.webbrowser, "open", opened.append)
    res = runner.invoke(sheet_cmd.app, ["open", "-s", SS])
    assert res.exit_code == 0, res.stderr
    expected = f"https://docs.google.com/spreadsheets/d/{SS}/edit"
    assert opened == [expected]
    assert expected in res.stdout


def test_open_specific_sheet(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(sheet_cmd.webbrowser, "open", opened.append)
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_metadata", _fake_get_metadata(_tabs()))
    res = runner.invoke(sheet_cmd.app, ["open", "Чек-лист", "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert opened == [f"https://docs.google.com/spreadsheets/d/{SS}/edit#gid=2"]


def test_open_unknown_sheet_exits_2(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(sheet_cmd.webbrowser, "open", opened.append)
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_metadata", _fake_get_metadata(_tabs()))
    res = runner.invoke(sheet_cmd.app, ["open", "NoSuch", "-s", SS])
    assert res.exit_code == 2
    assert "не найден" in res.stderr
    assert opened == []


# ────────────────────────────────────────────────────────────────────────────
# batch-get / batch-update (минимальное покрытие)
# ────────────────────────────────────────────────────────────────────────────


def test_batch_get_dry_run(db: sqlite3.Connection) -> None:
    res = runner.invoke(
        sheet_cmd.app, ["batch-get", "-s", SS, "-e", "get 'Sheet1'!A1:B2", "--dry-run"]
    )
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["values"] is not None
    assert out["meta"] is None


def test_batch_get_empty_script_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "-e", ""])
    assert res.exit_code == 2
    assert "пустой скрипт" in res.stderr


def test_batch_get_real_values(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "-e", "get 'Sheet1'!A1:B2"])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["spreadsheetId"] == SS
    assert "valueRanges" in out


def test_batch_update_dry_run(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    res = runner.invoke(
        sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "set A1 42", "--dry-run"]
    )
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert "requests" in out
    assert isinstance(out["requests"], list)


def test_batch_update_empty_script_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["batch-update", "-s", SS, "-e", "   "])
    assert res.exit_code == 2
    assert "пустой скрипт" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# get — `--sheet` prefixing / render layers / raw-tsv edge cases
# ────────────────────────────────────────────────────────────────────────────


def test_get_sheet_prefixes_bare_range(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def _capture(*a: object, **_kw: object) -> list[FetchResult]:
        captured["refs"] = a[3]
        return [
            FetchResult(
                range="Sheet1!A1", values=[["x"]], formulas=None, formatted=None, from_cache=False
            )
        ]

    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_ranges", _capture)
    res = runner.invoke(sheet_cmd.app, ["get", "A1", "-s", SS, "--sheet", "Sheet1"])
    assert res.exit_code == 0, res.stderr
    assert captured["refs"][0].tab == "Sheet1"


def test_get_sheet_only_means_whole_tab(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def _capture(*a: object, **_kw: object) -> list[FetchResult]:
        captured["refs"] = a[3]
        return [
            FetchResult(
                range="Sheet1!A1:Z100",
                values=[["x"]],
                formulas=None,
                formatted=None,
                from_cache=False,
            )
        ]

    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_ranges", _capture)
    res = runner.invoke(sheet_cmd.app, ["get", "-s", SS, "--sheet", "Sheet1"])
    assert res.exit_code == 0, res.stderr
    ref = captured["refs"][0]
    assert ref.tab == "Sheet1"
    assert ref.row1 is None  # весь tab


def test_get_json_includes_formulas_and_formatted(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1",
                    values=None,
                    formulas=[["=A2*2"]],
                    formatted=[["100 ₽"]],
                    from_cache=True,
                )
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS, "--render", "formulas"])
    assert res.exit_code == 0, res.stderr
    item: dict[str, Any] = json.loads(res.stdout)["valueRanges"][0]
    assert "values" not in item
    assert item["formulas"] == [["=A2*2"]]
    assert item["formatted"] == [["100 ₽"]]
    assert item["fromCache"] is True


def test_get_raw_picks_formulas_layer(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1",
                    values=None,
                    formulas=[["=SUM(B:B)"]],
                    formatted=None,
                    from_cache=False,
                )
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "-s", SS, "--raw"])
    assert res.exit_code == 0, res.stderr
    assert res.stdout == "=SUM(B:B)"


def test_get_tsv_skips_none_layer(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1",
                    values=None,
                    formulas=None,
                    formatted=[["fmt"]],
                    from_cache=False,
                ),
                FetchResult(
                    range="Sheet1!A2", values=None, formulas=None, formatted=None, from_cache=False
                ),
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1", "Sheet1!A2", "-s", SS, "--tsv"])
    assert res.exit_code == 0, res.stderr
    # Первый — formatted-слой; второй — все слои None (пропущен, только blank-разделитель).
    assert res.stdout == "fmt\n\n"


# ────────────────────────────────────────────────────────────────────────────
# set — from_env error / json branches / _expand_fill / no-tab invalidate
# ────────────────────────────────────────────────────────────────────────────


def test_set_from_env_error_exits_1(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raise() -> WebappClient:
        raise SheetApiError("WB_PLUS_WEB_APP_URL не задан")

    monkeypatch.setattr(WebappClient, "from_env", staticmethod(_raise))
    res = runner.invoke(sheet_cmd.app, ["set", "Sheet1!A1", "1", "-s", SS])
    assert res.exit_code == 1
    assert "mpu sheet set:" in res.stderr


@pytest.mark.parametrize(
    ("payload", "needle"),
    [
        ("[]", "непустой JSON-массив"),
        ("[1]", "не объект"),
        ('[{"value": "x"}]', "без поля range"),
        ('[{"range": "Sheet1!A1"}]', "без formula/value"),
    ],
)
def test_set_json_stdin_bad_shapes_exit_2(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch, payload: str, needle: str
) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    res = runner.invoke(sheet_cmd.app, ["set", "-s", SS], input=payload)
    assert res.exit_code == 2
    assert needle in res.stderr


def test_set_json_open_column_fill(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    api = FakeApi()
    api.batch_get_rows = [["1"], ["2"], ["3"], ["4"]]  # столбец на 4 строки
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(
        sheet_cmd.app, ["set", "-s", SS], input='[{"range": "Sheet1!A2:A", "value": "x"}]'
    )
    assert res.exit_code == 0, res.stderr
    data = api.batch_update_calls[0][1]
    # Заполнено от A2 до A4 (последняя строка с данными).
    assert data[0]["range"] == "Sheet1!A2:A4"
    assert data[0]["values"] == [["x"], ["x"], ["x"]]


def test_set_json_open_column_short(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeApi()
    api.batch_get_rows = []  # столбец короче start → одна ячейка
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(
        sheet_cmd.app, ["set", "-s", SS], input='[{"range": "Sheet1!A5:A", "value": "y"}]'
    )
    assert res.exit_code == 0, res.stderr
    data = api.batch_update_calls[0][1]
    assert data[0]["range"] == "Sheet1!A5"
    assert data[0]["values"] == [["y"]]


def test_set_range_without_tab_skips_invalidate(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    # range "A1" без таба → parse_range в invalidate бросает ValueError → continue.
    res = runner.invoke(sheet_cmd.app, ["set", "A1", "5", "-s", SS])
    assert res.exit_code == 0, res.stderr
    assert api.batch_update_calls[0][1][0]["range"] == "A1"


# ────────────────────────────────────────────────────────────────────────────
# batch-update / batch-get — error & send paths
# ────────────────────────────────────────────────────────────────────────────


def test_batch_update_compile_error_exits_2(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    res = runner.invoke(
        sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "frobnicate A1"]
    )
    assert res.exit_code == 2
    assert "неизвестный глагол" in res.stderr


def test_batch_update_sends_and_invalidates(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_tab(db, SS, "Sheet1")
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    res = runner.invoke(
        sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "set A1 42"]
    )
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out == {"replies": [{"ok": 1}]}
    # Затронутый Sheet1 (sheetId 7) → tab-кэш сброшен.
    n = db.execute("SELECT COUNT(*) AS n FROM sheet_tabs WHERE ss_id = ?", (SS,)).fetchone()["n"]
    assert n == 0


def test_batch_get_read_meta(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_from_env(monkeypatch, FakeApi())
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "-e", "read 'Sheet1' merges"])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["spreadsheetId"] == SS
    assert out["meta"]["sheets"][0]["title"] == "Sheet1"


def test_batch_get_api_error_exits_1(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _BoomApi(FakeApi):
        def call(self, action: str, **payload: Any) -> dict[str, Any]:
            raise SheetApiError("read blew up")

    _patch_from_env(monkeypatch, _BoomApi())
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "-e", "get 'Sheet1'!A1:B2"])
    assert res.exit_code == 1
    assert "read blew up" in res.stderr


def test_batch_get_compile_error_exits_2(db: sqlite3.Connection) -> None:
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "-e", "frobnicate A1"])
    assert res.exit_code == 2
    assert "mpu sheet batch-get:" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# open — SheetApiError на метаданных
# ────────────────────────────────────────────────────────────────────────────


def test_open_sheet_api_error_exits_1(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sheet_cmd.webbrowser, "open", _noop_open)
    _patch_from_env(monkeypatch, object())

    def _boom(*_a: object, **_kw: object) -> list[TabInfo]:
        raise SheetApiError("meta unavailable")

    monkeypatch.setattr(sheet_cmd, "get_metadata", _boom)
    res = runner.invoke(sheet_cmd.app, ["open", "Sheet1", "-s", SS])
    assert res.exit_code == 1
    assert "meta unavailable" in res.stderr


# ────────────────────────────────────────────────────────────────────────────
# Дополнительные ветки покрытия
# ────────────────────────────────────────────────────────────────────────────


def test_get_sheet_keeps_qualified_range(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--sheet Default`, но range уже с `Tab!` → префикс не навешивается."""
    captured: dict[str, Any] = {}

    def _capture(*a: object, **_kw: object) -> list[FetchResult]:
        captured["refs"] = a[3]
        return [
            FetchResult(
                range="Other!A1", values=[["x"]], formulas=None, formatted=None, from_cache=False
            )
        ]

    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(sheet_cmd, "get_ranges", _capture)
    res = runner.invoke(sheet_cmd.app, ["get", "Other!A1", "-s", SS, "--sheet", "Sheet1"])
    assert res.exit_code == 0, res.stderr
    assert captured["refs"][0].tab == "Other"


def test_get_raw_multi_result_and_none_layer(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_from_env(monkeypatch, object())
    monkeypatch.setattr(
        sheet_cmd,
        "get_ranges",
        _fake_get_ranges(
            [
                FetchResult(
                    range="Sheet1!A1:B1",
                    values=[["a", "b"]],
                    formulas=None,
                    formatted=None,
                    from_cache=False,
                ),
                FetchResult(
                    range="Sheet1!A2", values=None, formulas=None, formatted=None, from_cache=False
                ),  # None-слой → пропускается
            ]
        ),
    )
    res = runner.invoke(sheet_cmd.app, ["get", "Sheet1!A1:B1", "Sheet1!A2", "-s", SS, "--raw"])
    assert res.exit_code == 0, res.stderr
    assert res.stdout == "a\tb\n"


def test_set_json_formula_uses_user_entered(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = FakeApi()
    _patch_from_env(monkeypatch, api)
    res = runner.invoke(
        sheet_cmd.app, ["set", "-s", SS], input='[{"range": "Sheet1!A1", "formula": "=A2*2"}]'
    )
    assert res.exit_code == 0, res.stderr
    _ss_id, data, opt = api.batch_update_calls[0]
    assert opt == "USER_ENTERED"
    assert data[0]["values"] == [["=A2*2"]]


def test_batch_update_from_env_error_exits_1(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raise() -> WebappClient:
        raise SheetApiError("no webapp url")

    monkeypatch.setattr(WebappClient, "from_env", staticmethod(_raise))
    res = runner.invoke(sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "set A1 1"])
    assert res.exit_code == 1
    assert "no webapp url" in res.stderr


def test_batch_update_send_error_exits_1(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _BoomApi(FakeApi):
        def batch_update_spreadsheet(
            self, ss_id: str, requests: list[dict[str, Any]]
        ) -> dict[str, Any]:
            raise SheetApiError("batchUpdate rejected")

    _patch_from_env(monkeypatch, _BoomApi())
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    res = runner.invoke(
        sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "set A1 42"]
    )
    assert res.exit_code == 1
    assert "batchUpdate rejected" in res.stderr


def test_batch_update_allow_py(db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    """`py{…}` exec под `--allow-py`: emit/request/col/rgb/sheetid/gridrange/read."""
    _patch_from_env(monkeypatch, FakeApi())
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    body = (
        'emit("set A1 5"); request({"noOp": {}}); col(1); rgb("#fff"); '
        'sheetid("Sheet1"); gridrange("Sheet1!A1"); read("\'Sheet1\'!A1")'
    )
    res = runner.invoke(
        sheet_cmd.app,
        [
            "batch-update",
            "-s",
            SS,
            "-n",
            "Sheet1",
            "--allow-py",
            "--dry-run",
            "-e",
            f"py{{{body}}}",
        ],
    )
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert {"noOp": {}} in out["requests"]


def test_batch_update_comment_only_no_ops(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Скрипт из одних комментариев компилируется в 0 операций → «нет операций»."""
    _patch_from_env(monkeypatch, FakeApi())
    monkeypatch.setattr(
        sheet_cmd,
        "get_metadata",
        _fake_get_metadata([TabInfo(title="Sheet1", sheet_id=7, rows=100, cols=26, index=0)]),
    )
    res = runner.invoke(
        sheet_cmd.app, ["batch-update", "-s", SS, "-n", "Sheet1", "-e", "# просто комментарий"]
    )
    assert res.exit_code == 0, res.stderr
    assert "нет операций" in res.stdout


def test_batch_get_from_file(
    db: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = tmp_path / "read.txt"
    script.write_text("get 'Sheet1'!A1:B2\n")
    res = runner.invoke(sheet_cmd.app, ["batch-get", "-s", SS, "--from", str(script), "--dry-run"])
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["values"] is not None


def test_batch_get_stdin_pipe(db: sqlite3.Connection) -> None:
    res = runner.invoke(
        sheet_cmd.app, ["batch-get", "-s", SS, "--dry-run"], input="get 'Sheet1'!A1:B2\n"
    )
    assert res.exit_code == 0, res.stderr
    out: dict[str, Any] = json.loads(res.stdout)
    assert out["values"] is not None
