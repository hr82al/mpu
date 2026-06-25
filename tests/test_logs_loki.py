"""Тесты `commands/_logs_loki.py`: сборка LogQL, run/follow, резолв, кэш-хелперы."""
# pyright: reportPrivateUsage=false

import time
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
import typer

from mpu.commands import _logs_loki
from mpu.commands._logs_loki import _build_logql
from mpu.lib import loki, servers, store
from mpu.lib.resolver import ResolveError


def _q(
    *,
    host: str = "wb-2",
    service: str | None = None,
    level: str | None = None,
    no_stdout: bool = False,
    no_stderr: bool = False,
    grep: list[str] | None = None,
    grep_regex: list[str] | None = None,
    client_id: int | None = None,
) -> str:
    return _build_logql(
        host=host,
        service=service,
        level=level,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep or [],
        grep_regex=grep_regex or [],
        client_id=client_id,
    )


def test_no_filters_just_selector() -> None:
    assert _q() == '{host="wb-2"}'


def test_single_grep_literal() -> None:
    assert _q(grep=["[wbAnalytics]"]) == '{host="wb-2"} |= `[wbAnalytics]`'


def test_multiple_grep_anded_in_order() -> None:
    out = _q(grep=["[wbAnalytics] LOADER BLOCKED", "requires admin resume"])
    assert out == ('{host="wb-2"} |= `[wbAnalytics] LOADER BLOCKED` |= `requires admin resume`')


def test_grep_regex_uses_pipe_tilde() -> None:
    assert _q(grep_regex=["reason=unknown_error.*aborted"]) == (
        '{host="wb-2"} |~ `reason=unknown_error.*aborted`'
    )


def test_grep_and_grep_regex_combined_order() -> None:
    out = _q(grep=["[wbAnalytics]"], grep_regex=["aborted .+ admin resume"])
    # literal'ы → потом regex'ы
    assert out == '{host="wb-2"} |= `[wbAnalytics]` |~ `aborted .+ admin resume`'


def test_service_and_streams_in_label_block() -> None:
    out = _q(service="wb-data-loaders", no_stdout=True, no_stderr=True, grep=["x"])
    assert out == (
        '{host="wb-2",compose_service="wb-data-loaders",stream!="stdout",stream!="stderr"} |= `x`'
    )


def test_client_id_and_level_appended_after_greps() -> None:
    out = _q(grep=["a"], grep_regex=["b"], client_id=42, level="ERROR")
    assert out == '{host="wb-2"} |= `a` |~ `b` |= `42` | detected_level="error"'


def test_backtick_in_value_falls_back_to_double_quote() -> None:
    # значение с backtick — _quote_line_filter уходит в "..."-форму
    out = _q(grep=["a`b"])
    assert out == '{host="wb-2"} |= "a`b"'


def test_empty_lists_no_line_filters() -> None:
    assert _q(grep=[], grep_regex=[]) == '{host="wb-2"}'


# ── общие дублёры / хелперы для run / follow ──────────────────────────────────


def _entry(ts_ns: int, line: str) -> loki.LogEntry:
    return loki.LogEntry(ts_ns=ts_ns, line=line, labels={})


def _fixed_time() -> float:
    """Детерминированный `time.time()` — 1000.0 (now_s == 1000)."""
    return 1000.0


def _env_loki(url: str | None) -> Callable[[str], str | None]:
    """Дублёр `servers.env_value`: отдаёт `url` для LOKI_URL, иначе None."""

    def _env(key: str) -> str | None:
        return url if key == "LOKI_URL" else None

    return _env


def _http_status_error(status_code: int, body: str) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "http://loki/loki/api/v1/query_range")
    response = httpx.Response(status_code, text=body, request=request)
    return httpx.HTTPStatusError(str(status_code), request=request, response=response)


class _FakeQueryRange:
    """Программируемый дублёр `loki.query_range`: очередь ответов / исключений.

    Каждый вызов снимает следующий элемент: `list[LogEntry]` → вернуть, исключение →
    бросить. Пустая очередь → `[]`. Все kwargs запоминаются в `.calls`.
    """

    def __init__(self, actions: list[list[loki.LogEntry] | BaseException]) -> None:
        self._actions: list[list[loki.LogEntry] | BaseException] = list(actions)
        self.calls: list[dict[str, object]] = []

    def __call__(self, **kwargs: object) -> list[loki.LogEntry]:
        self.calls.append(kwargs)
        if not self._actions:
            return []
        action = self._actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action


class _SleepStopper:
    """Дублёр `time.sleep`: пропускает `allow` вызовов, затем KeyboardInterrupt.

    KeyboardInterrupt ловит сам `follow` — это нормальный выход из poll-цикла.
    """

    def __init__(self, allow: int) -> None:
        self.allow = allow
        self.count = 0

    def __call__(self, _seconds: float) -> None:
        self.count += 1
        if self.count > self.allow:
            raise KeyboardInterrupt


def _call_run(
    *,
    command_name: str = "logs",
    selector: str | None = "sl-1",
    service: str | None = None,
    tail: int = 100,
    since: str | None = None,
    timestamps: bool = False,
    no_stdout: bool = False,
    no_stderr: bool = False,
    grep: list[str] | None = None,
    grep_regex: list[str] | None = None,
    level: str | None = None,
    client_id: int | None = None,
) -> None:
    _logs_loki.run(
        command_name=command_name,
        selector=selector,
        service=service,
        tail=tail,
        since=since,
        timestamps=timestamps,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep or [],
        grep_regex=grep_regex or [],
        level=level,
        client_id=client_id,
    )


def _call_follow(
    *,
    command_name: str = "logs",
    selector: str | None = "sl-1",
    service: str | None = None,
    since: str | None = None,
    timestamps: bool = False,
    no_stdout: bool = False,
    no_stderr: bool = False,
    grep: list[str] | None = None,
    grep_regex: list[str] | None = None,
    level: str | None = None,
    client_id: int | None = None,
) -> None:
    _logs_loki.follow(
        command_name=command_name,
        selector=selector,
        service=service,
        since=since,
        timestamps=timestamps,
        no_stdout=no_stdout,
        no_stderr=no_stderr,
        grep=grep or [],
        grep_regex=grep_regex or [],
        level=level,
        client_id=client_id,
    )


# ── run() — one-shot ──────────────────────────────────────────────────────────


def test_run_missing_loki_url_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki(None))
    with pytest.raises(typer.Exit) as ei:
        _call_run()
    assert ei.value.exit_code == 2
    assert "LOKI_URL не задан" in capsys.readouterr().err


def test_run_prints_entries_sorted_ascending(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki:3100"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[_entry(992_000_000_000, "b"), _entry(991_000_000_000, "a")]])
    monkeypatch.setattr(loki, "query_range", fake)
    _call_run(selector="sl-1")
    assert capsys.readouterr().out == "a\nb\n"
    # tail прокинут как limit; direct-host селектор → host="sl-1" в LogQL.
    assert fake.calls[0]["limit"] == 100
    assert fake.calls[0]["logql"] == '{host="sl-1"}'
    assert fake.calls[0]["base_url"] == "http://loki:3100"


def test_run_with_timestamps_prefixes_iso(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([[_entry(1_234_000_000, "hello")]]))
    _call_run(timestamps=True)
    assert capsys.readouterr().out == "1970-01-01T00:00:01.234Z hello\n"


def test_run_no_entries_no_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([[]]))
    _call_run()
    assert capsys.readouterr().out == ""


def test_run_idempotent_same_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([[_entry(1, "x")], [_entry(1, "x")]]))
    _call_run()
    first = capsys.readouterr().out
    _call_run()
    second = capsys.readouterr().out
    assert first == second == "x\n"


def test_run_selector_none_uses_wildcard_host(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[]])
    monkeypatch.setattr(loki, "query_range", fake)
    _call_run(selector=None)
    assert fake.calls[0]["logql"] == '{host=~".+"}'


def test_run_resolves_non_direct_selector_to_sl(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)

    def _resolve(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        _ = value, server_override
        return 3, []

    monkeypatch.setattr(_logs_loki, "resolve_server", _resolve)
    fake = _FakeQueryRange([[]])
    monkeypatch.setattr(loki, "query_range", fake)
    _call_run(selector="SOMECLIENT")
    assert fake.calls[0]["logql"] == '{host="sl-3"}'


def test_run_http_status_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(
        loki, "query_range", _FakeQueryRange([_http_status_error(503, "overloaded")])
    )
    with pytest.raises(typer.Exit) as ei:
        _call_run()
    assert ei.value.exit_code == 1
    err = capsys.readouterr().err
    assert "loki HTTP 503" in err
    assert "overloaded" in err
    assert "query:" in err


def test_run_http_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([httpx.ConnectError("refused")]))
    with pytest.raises(typer.Exit) as ei:
        _call_run()
    assert ei.value.exit_code == 1
    assert "loki error: refused" in capsys.readouterr().err


def test_run_invalid_since_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)

    def _no_call(**_kw: object) -> list[loki.LogEntry]:
        raise AssertionError("query_range не должен вызываться при битом --since")

    monkeypatch.setattr(loki, "query_range", _no_call)
    with pytest.raises(typer.Exit) as ei:
        _call_run(since="not-a-duration")
    assert ei.value.exit_code == 2
    assert "--since" in capsys.readouterr().err


# ── _selector_to_host ─────────────────────────────────────────────────────────


def test_selector_to_host_direct_returned_asis() -> None:
    for sel in ["sl-1", "wb-3", "dt-1", "wb-clusters", "wb-positions"]:
        assert _logs_loki._selector_to_host(sel, command_name="logs") == sel


def test_selector_to_host_resolver_maps_to_sl(monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        _ = value, server_override
        return 7, []

    monkeypatch.setattr(_logs_loki, "resolve_server", _resolve)
    assert _logs_loki._selector_to_host("CLIENT", command_name="logs") == "sl-7"


def test_selector_to_host_resolve_error_with_candidates_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def _resolve(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        _ = value, server_override
        raise ResolveError(
            "ambiguous selector",
            candidates=[{"client_id": 1, "server": "sl-1", "title": "ACME"}],
        )

    monkeypatch.setattr(_logs_loki, "resolve_server", _resolve)
    with pytest.raises(typer.Exit) as ei:
        _logs_loki._selector_to_host("CLIENT", command_name="logs")
    assert ei.value.exit_code == 2
    err = capsys.readouterr().err
    assert "ambiguous selector" in err
    assert "client_id=1" in err


def test_selector_to_host_resolve_error_no_candidates_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def _resolve(value: str, *, server_override: str | None = None) -> tuple[int, list[object]]:
        _ = value, server_override
        raise ResolveError("nothing matched: 'x'")

    monkeypatch.setattr(_logs_loki, "resolve_server", _resolve)
    with pytest.raises(typer.Exit) as ei:
        _logs_loki._selector_to_host("x", command_name="logs")
    assert ei.value.exit_code == 2
    assert "nothing matched" in capsys.readouterr().err


# ── _time_range ───────────────────────────────────────────────────────────────


def test_time_range_default_last_5_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", _fixed_time)
    start, end = _logs_loki._time_range(None, command_name="logs")
    assert end == 1000 * 1_000_000_000
    assert start == (1000 - 300) * 1_000_000_000


def test_time_range_relative_since(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", _fixed_time)
    start, end = _logs_loki._time_range("5m", command_name="logs")
    assert start == (1000 - 300) * 1_000_000_000
    assert end == 1000 * 1_000_000_000


def test_time_range_absolute_digit_since(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", _fixed_time)
    start, end = _logs_loki._time_range("60", command_name="logs")
    assert start == 60 * 1_000_000_000
    assert end == 1000 * 1_000_000_000


def test_time_range_invalid_since_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(time, "time", _fixed_time)
    with pytest.raises(typer.Exit) as ei:
        _logs_loki._time_range("xyz", command_name="logs")
    assert ei.value.exit_code == 2
    assert "--since" in capsys.readouterr().err


# ── is_direct_host ────────────────────────────────────────────────────────────


def test_is_direct_host_true() -> None:
    for sel in ["sl-0", "wb-12", "dt-1", "wb-clusters", "wb-positions"]:
        assert _logs_loki.is_direct_host(sel)


def test_is_direct_host_false() -> None:
    for sel in ["MODERNICA", "sl-", "frontend", "", "sl-1x", "wb-clustersx"]:
        assert not _logs_loki.is_direct_host(sel)


# ── _print_entry / _format_ts ─────────────────────────────────────────────────


def test_print_entry_plain_strips_trailing_newline(capsys: pytest.CaptureFixture[str]) -> None:
    _logs_loki._print_entry(_entry(5, "line\n"), timestamps=False)
    assert capsys.readouterr().out == "line\n"


def test_print_entry_with_timestamp(capsys: pytest.CaptureFixture[str]) -> None:
    _logs_loki._print_entry(_entry(1_000_000_000, "msg"), timestamps=True)
    assert capsys.readouterr().out == "1970-01-01T00:00:01.000Z msg\n"


def test_format_ts_iso_with_millis() -> None:
    assert _logs_loki._format_ts(0) == "1970-01-01T00:00:00.000Z"
    assert _logs_loki._format_ts(1_234_000_000) == "1970-01-01T00:00:01.234Z"


# ── follow() — poll loop ──────────────────────────────────────────────────────


def test_follow_missing_loki_url_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki(None))
    with pytest.raises(typer.Exit) as ei:
        _call_follow()
    assert ei.value.exit_code == 2


def test_follow_invalid_since_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)

    def _no_call(**_kw: object) -> list[loki.LogEntry]:
        raise AssertionError("query_range не должен вызываться при битом --since")

    monkeypatch.setattr(loki, "query_range", _no_call)
    with pytest.raises(typer.Exit) as ei:
        _call_follow(since="nope")
    assert ei.value.exit_code == 2
    assert "--since" in capsys.readouterr().err


def test_follow_initial_http_status_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([_http_status_error(500, "boom")]))
    with pytest.raises(typer.Exit) as ei:
        _call_follow()
    assert ei.value.exit_code == 1
    err = capsys.readouterr().err
    assert "loki HTTP 500" in err
    assert "query:" in err


def test_follow_initial_http_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    monkeypatch.setattr(loki, "query_range", _FakeQueryRange([httpx.ConnectError("refused")]))
    with pytest.raises(typer.Exit) as ei:
        _call_follow()
    assert ei.value.exit_code == 1
    assert "loki error: refused" in capsys.readouterr().err


def test_follow_polls_then_exits_on_keyboard_interrupt(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    initial = [_entry(991_000_000_000, "hist1"), _entry(992_000_000_000, "hist2")]
    poll = [_entry(993_000_000_000, "new1")]
    fake = _FakeQueryRange([initial, poll])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=1))
    _call_follow()
    # initial → flush; poll → new1; KeyboardInterrupt-хэндлер дописывает "\n".
    assert capsys.readouterr().out == "hist1\nhist2\nnew1\n\n"
    assert fake.calls[0]["direction"] == "forward"
    assert fake.calls[0]["limit"] == 500
    # poll стартует на 1ns позже последнего показанного ts.
    assert fake.calls[1]["start_ns"] == 992_000_000_000 + 1
    assert fake.calls[1]["limit"] == 1000


def test_follow_poll_http_status_error_continues(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[], _http_status_error(502, "bad gw")])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=1))
    _call_follow()
    err = capsys.readouterr().err
    assert "loki HTTP 502" in err


def test_follow_poll_http_error_continues(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[], httpx.ConnectError("dropped")])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=1))
    _call_follow()
    assert "loki error: dropped" in capsys.readouterr().err


def test_follow_poll_empty_loops_without_advancing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пустой poll-ответ → `last_ts_ns` не двигается, цикл идёт дальше (branch 201->177)."""
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[], []])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=1))
    _call_follow()
    # initial [] (нечего печатать) + один пустой poll + завершающий "\n".
    assert capsys.readouterr().out == "\n"
    assert len(fake.calls) == 2


def test_follow_keyboard_interrupt_on_first_sleep(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[_entry(995_000_000_000, "h")]])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=0))
    _call_follow()
    # initial entry + завершающий "\n"; poll-запрос не успевает произойти.
    assert capsys.readouterr().out == "h\n\n"
    assert len(fake.calls) == 1


def test_follow_since_used_for_initial_window(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(servers, "env_value", _env_loki("http://loki"))
    monkeypatch.setattr(time, "time", _fixed_time)
    fake = _FakeQueryRange([[]])
    monkeypatch.setattr(loki, "query_range", fake)
    monkeypatch.setattr(time, "sleep", _SleepStopper(allow=0))
    _call_follow(since="2m")
    # parse_since("2m") = 1000 - 120 = 880 → start_ns, end_ns = now.
    assert fake.calls[0]["start_ns"] == 880 * 1_000_000_000
    assert fake.calls[0]["end_ns"] == 1000 * 1_000_000_000


# ── cached_* helpers (cold vs warm via sqlite) ────────────────────────────────


@pytest.fixture
def loki_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bootstrap_db: Callable[[Path | str], None],
) -> Path:
    """Изолированная bootstrap'нутая SQLite на tmp-пути (подменяет prod mpu.db)."""
    db = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db)
    bootstrap_db(db)
    return db


def _seed_hosts(hosts: list[str]) -> None:
    with store.store() as conn:
        for h in hosts:
            conn.execute("INSERT INTO loki_hosts(host, discovered_at) VALUES (?, ?)", (h, 1))
        conn.commit()


def _seed_services(pairs: list[tuple[str, str]]) -> None:
    with store.store() as conn:
        for host, svc in pairs:
            conn.execute(
                "INSERT INTO loki_services_by_host(host, service, discovered_at) VALUES (?, ?, ?)",
                (host, svc, 1),
            )
        conn.commit()


def test_cached_hosts_warm_sorted(loki_db: Path) -> None:
    _ = loki_db
    _seed_hosts(["sl-2", "sl-1", "wb-0"])
    assert _logs_loki.cached_hosts() == ["sl-1", "sl-2", "wb-0"]


def test_cached_hosts_cold_empty(loki_db: Path) -> None:
    _ = loki_db
    assert _logs_loki.cached_hosts() == []


def test_cached_hosts_sqlite_error_returns_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # БД без bootstrap → нет таблицы loki_hosts → sqlite3.Error → [].
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "empty.db")
    assert _logs_loki.cached_hosts() == []


def test_cached_services_for_host_warm(loki_db: Path) -> None:
    _ = loki_db
    _seed_services([("sl-1", "api"), ("sl-1", "wb-loader"), ("sl-2", "api")])
    assert _logs_loki.cached_services_for_host("sl-1") == ["api", "wb-loader"]


def test_cached_services_for_host_cold(loki_db: Path) -> None:
    _ = loki_db
    assert _logs_loki.cached_services_for_host("sl-1") == []


def test_cached_services_for_host_sqlite_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "empty.db")
    assert _logs_loki.cached_services_for_host("sl-1") == []


def test_cached_all_services_distinct_sorted(loki_db: Path) -> None:
    _ = loki_db
    _seed_services([("sl-1", "api"), ("sl-2", "api"), ("sl-1", "wb-loader")])
    assert _logs_loki.cached_all_services() == ["api", "wb-loader"]


def test_cached_all_services_cold(loki_db: Path) -> None:
    _ = loki_db
    assert _logs_loki.cached_all_services() == []


def test_cached_all_services_sqlite_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "empty.db")
    assert _logs_loki.cached_all_services() == []


# ── print_*_ls ────────────────────────────────────────────────────────────────


def test_print_hosts_ls_lists_hosts(loki_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _ = loki_db
    _seed_hosts(["sl-1", "sl-2"])
    _logs_loki.print_hosts_ls(command_name="logs")
    assert capsys.readouterr().out == "sl-1\nsl-2\n"


def test_print_hosts_ls_empty_exits_2(loki_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _ = loki_db
    with pytest.raises(typer.Exit) as ei:
        _logs_loki.print_hosts_ls(command_name="logs")
    assert ei.value.exit_code == 2
    assert "кэш hosts пуст" in capsys.readouterr().err


def test_print_all_services_ls_lists(loki_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _ = loki_db
    _seed_services([("sl-1", "api"), ("sl-2", "wb-loader")])
    _logs_loki.print_all_services_ls(command_name="logs")
    assert capsys.readouterr().out == "api\nwb-loader\n"


def test_print_all_services_ls_empty_exits_2(
    loki_db: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _ = loki_db
    with pytest.raises(typer.Exit) as ei:
        _logs_loki.print_all_services_ls(command_name="logs")
    assert ei.value.exit_code == 2
    assert "кэш services пуст" in capsys.readouterr().err


def test_print_services_ls_lists_for_host(
    loki_db: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _ = loki_db
    _seed_services([("sl-1", "api"), ("sl-1", "internal-api")])
    _logs_loki.print_services_ls("sl-1", command_name="logs")
    assert capsys.readouterr().out == "api\ninternal-api\n"


def test_print_services_ls_empty_exits_2(loki_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _ = loki_db
    with pytest.raises(typer.Exit) as ei:
        _logs_loki.print_services_ls("sl-9", command_name="logs")
    assert ei.value.exit_code == 2
    err = capsys.readouterr().err
    assert "sl-9" in err
    assert "нет services" in err
