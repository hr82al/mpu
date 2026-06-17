"""Unit-тесты `mpu api wb-loader-blocked` (`commands/wb_loader_blocked.py`).

Селектора нет — `resolve_server` не задействован. HTTP / clipboard / base_url /
кэш серверов мокаются (без сети, без записи в реальный ~/.config).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import click
import pytest
from click.testing import CliRunner

from mpu.commands import wb_loader_blocked as wlb

runner = CliRunner()

# Приватные символы — алиасы с одним подавлением (стиль test_wb_loader_resume.py).
FIND_PATH: str = wlb._FIND_PATH  # pyright: ignore[reportPrivateUsage]


class FakeSlApi:
    """Подмена `SlApi`: отдаёт ответ по (method, path) или кидает. Только find."""

    base_url = "https://mp.example/api"

    def __init__(self, responses: dict[tuple[str, str], Any]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, str, Any]] = []

    @classmethod
    def from_env(cls) -> FakeSlApi:
        raise AssertionError("from_env должен быть подменён")

    def request(
        self,
        method: str,
        pathname: str,
        *,
        body: Any = None,
        query: Any = None,
        no_auth: bool = False,
    ) -> Any:
        _ = query, no_auth
        self.calls.append((method, pathname, body))
        if (method, pathname) not in self._responses:
            raise AssertionError(f"unexpected request {method} {pathname}")
        value = self._responses[method, pathname]
        if isinstance(value, Exception):
            raise value
        return value


def _patch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    api: FakeSlApi | None,
) -> tuple[list[str], Path]:
    """Мок SlApi / base_url / clipboard / путь кэша. Возвращает (clipboard, cache_path)."""
    clip: list[str] = []
    cache_path = tmp_path / ".wb-loader-servers.json"

    def _base() -> str:
        return "https://mp.example/api"

    def _clip(text: str) -> bool:
        clip.append(text)
        return True

    def _from_env() -> FakeSlApi:
        assert api is not None
        return api

    monkeypatch.setattr(wlb, "resolve_base_url", _base)
    monkeypatch.setattr(wlb, "copy_to_clipboard", _clip)
    monkeypatch.setattr(wlb, "_servers_cache_path", lambda: cache_path)
    if api is not None:
        monkeypatch.setattr(wlb.SlApi, "from_env", _from_env)
    return clip, cache_path


def _cmd() -> click.Command:
    return wlb.build_command()


def _find_body(api: FakeSlApi) -> Any:
    call = next(c for c in api.calls if c[1] == FIND_PATH)
    return call[2]


# 1. Без опций → body {"filter": {}}, stdout data, stderr сводка.
def test_no_filter_global(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi(
        {
            ("POST", FIND_PATH): {
                "data": [{"sid": "S1", "loader": "wbCards", "server": "wb-1"}],
                "errors": [],
            }
        }
    )
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), [])
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {"filter": {}}
    assert '"loader": "wbCards"' in result.output
    assert "1 blocked loader(s) across 1 server(s); 0 server error(s)" in result.stderr


# 2. --reason → API-фильтр.
def test_reason_filter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi({("POST", FIND_PATH): {"data": [], "errors": []}})
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), ["--reason", "no_token"])
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {"filter": {"reason": "no_token"}}


# 3. --only-permanent → flag в фильтре.
def test_only_permanent_filter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi({("POST", FIND_PATH): {"data": [], "errors": []}})
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), ["--only-permanent"])
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {"filter": {"only_permanent": True}}


# 4. --loader валиден / неизвестный loader → exit 2 без сети.
def test_loader_filter_and_validation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi({("POST", FIND_PATH): {"data": [], "errors": []}})
    _patch(monkeypatch, tmp_path, api=api)
    ok = runner.invoke(_cmd(), ["--loader", "wbAnalytics"])
    assert ok.exit_code == 0, ok.output
    assert _find_body(api) == {"filter": {"loader": "wbAnalytics"}}

    bad = runner.invoke(_cmd(), ["--loader", "wbBogus"])
    assert bad.exit_code == 2
    assert "неизвестный loader" in bad.stderr


# 5. Неизвестный reason → exit 2 без сети.
def test_unknown_reason(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _patch(monkeypatch, tmp_path, api=None)
    result = runner.invoke(_cmd(), ["--reason", "bogus"])
    assert result.exit_code == 2
    assert "неизвестный reason" in result.stderr


# 6. --sid → API-фильтр.
def test_sid_filter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi({("POST", FIND_PATH): {"data": [], "errors": []}})
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), ["--sid", "SX"])
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {"filter": {"sid": "SX"}}


# 7. Комбинация API-фильтров склеивается.
def test_combined_filters(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi({("POST", FIND_PATH): {"data": [], "errors": []}})
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(
        _cmd(), ["--loader", "wbCards", "--reason", "unknown_error", "--only-permanent"]
    )
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {
        "filter": {"loader": "wbCards", "reason": "unknown_error", "only_permanent": True}
    }


# 8. errors[] в ответе → в выводе и в сводке.
def test_errors_surface(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi(
        {
            ("POST", FIND_PATH): {
                "data": [],
                "errors": [{"server": "wb-3", "error": "server_unavailable"}],
            }
        }
    )
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), [])
    assert result.exit_code == 0, result.output
    assert "server_unavailable" in result.output
    assert "1 server error(s)" in result.stderr


# 9. --print → curl на find, SlApi НЕ вызывается, попал в clipboard.
def test_print_emits_find_curl(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clip, _ = _patch(monkeypatch, tmp_path, api=None)  # from_env не подменён → вызов = ошибка
    result = runner.invoke(_cmd(), ["--only-permanent", "--print"])
    assert result.exit_code == 0, result.output
    assert "TOKEN=$(mpu api get-token)" in result.output
    assert FIND_PATH in result.output
    assert '{"filter": {"only_permanent": true}}' in result.output
    assert clip and "curl -sS -X POST" in clip[0]


# 10. --print + --server → в curl только API-filter, плюс комментарий про клиентский фильтр.
def test_print_server_is_client_side(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _patch(monkeypatch, tmp_path, api=None)
    result = runner.invoke(_cmd(), ["--server", "wb-2", "--print"])
    assert result.exit_code == 0, result.output
    assert "-d '{\"filter\": {}}'" in result.output  # server НЕ в теле
    assert 'select(.server == "wb-2")' in result.output  # клиентский фильтр-подсказка


# 11. --server — клиентский фильтр: body остаётся {"filter":{}}, в выводе только wb-1.
def test_server_client_filter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    api = FakeSlApi(
        {
            ("POST", FIND_PATH): {
                "data": [
                    {"sid": "S1", "loader": "wbCards", "server": "wb-1"},
                    {"sid": "S2", "loader": "wbOrders", "server": "wb-2"},
                ],
                "errors": [],
            }
        }
    )
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), ["--server", "wb-1"])
    assert result.exit_code == 0, result.output
    assert _find_body(api) == {"filter": {}}  # server в API не уходит
    # CliRunner подмешивает stderr-сводку в output → берём JSON с первой "{".
    payload = json.loads(result.output[result.output.index("{") :])
    assert [r["server"] for r in payload["data"]] == ["wb-1"]
    assert "filtered by server=wb-1" in result.stderr


# 12. Кэш серверов пишется из ПОЛНОГО ответа (включая отфильтрованные --server).
def test_servers_cache_written_from_full_response(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    api = FakeSlApi(
        {
            ("POST", FIND_PATH): {
                "data": [
                    {"sid": "S1", "loader": "wbCards", "server": "wb-1"},
                    {"sid": "S2", "loader": "wbOrders", "server": "wb-2"},
                ],
                "errors": [{"server": "wb-5", "error": "http_503"}],
            }
        }
    )
    _, cache_path = _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), ["--server", "wb-1"])
    assert result.exit_code == 0, result.output
    assert json.loads(cache_path.read_text(encoding="utf-8")) == ["wb-1", "wb-2", "wb-5"]


# 13. _complete_server: с кэшем — префиксные совпадения; без кэша — [] (не падает).
def test_complete_server_from_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cache_path = tmp_path / ".wb-loader-servers.json"
    monkeypatch.setattr(wlb, "_servers_cache_path", lambda: cache_path)
    cmd = _cmd()
    ctx = click.Context(cmd)
    server_param = next(p for p in cmd.params if p.name == "server")

    # Без кэша.
    assert wlb._complete_server(ctx, server_param, "wb") == []  # pyright: ignore[reportPrivateUsage]

    # С кэшем.
    cache_path.write_text(json.dumps(["wb-1", "wb-2", "sl-9"]), encoding="utf-8")
    assert wlb._complete_server(ctx, server_param, "wb-") == ["wb-1", "wb-2"]  # pyright: ignore[reportPrivateUsage]


# 14. _complete_reason — статический список причин.
def test_complete_reason_static(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _ = monkeypatch, tmp_path
    cmd = _cmd()
    ctx = click.Context(cmd)
    reason_param = next(p for p in cmd.params if p.name == "reason")
    out = wlb._complete_reason(ctx, reason_param, "db_")  # pyright: ignore[reportPrivateUsage]
    assert out == ["db_write_error"]


# 15. 403 → exit 1 + подсказка про роль.
def test_find_forbidden_403(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from mpu.lib.slapi import SlApiError

    api = FakeSlApi(
        {("POST", FIND_PATH): SlApiError("forbidden", status=403, body="role required")}
    )
    _patch(monkeypatch, tmp_path, api=api)
    result = runner.invoke(_cmd(), [])
    assert result.exit_code == 1
    assert "support_read" in result.stderr
