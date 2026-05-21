"""Тесты сборки LogQL в `commands/_logs_loki.py` — повторяемые --grep / --grep-regex."""
# pyright: reportPrivateUsage=false

from mpu.commands._logs_loki import _build_logql


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
