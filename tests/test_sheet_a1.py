"""Тесты A1-нотации (`lib/sheet_cache.py::parse_range`, col conversions).

Портировано из new-mpu/tests/a1.test.ts. Отличия от new-mpu:
- мы ПОДДЕРЖИВАЕМ open-ended ranges (`A:A`, `1:5`) — нужны для prod ranges.
- мы НЕ нормализуем порядок координат при парсинге (отсутствует у new-mpu).
"""

from __future__ import annotations

import pytest

from mpu.lib.sheet_cache import (
    col_letters_to_num,
    col_num_to_letters,
    parse_range,
)


@pytest.mark.parametrize(
    ("letters", "num"),
    [
        ("A", 1),
        ("B", 2),
        ("Z", 26),
        ("AA", 27),
        ("AZ", 52),
        ("BA", 53),
        ("ZZ", 702),
        ("AAA", 703),
    ],
)
def test_col_letters_to_num_and_back(letters: str, num: int) -> None:
    assert col_letters_to_num(letters) == num
    assert col_num_to_letters(num) == letters


def test_col_letters_case_insensitive() -> None:
    assert col_letters_to_num("aa") == 27


def test_col_num_to_letters_invalid() -> None:
    with pytest.raises(ValueError):
        col_num_to_letters(0)
    with pytest.raises(ValueError):
        col_num_to_letters(-1)


def test_parse_range_single_cell() -> None:
    r = parse_range("Sheet1!B5")
    assert r.tab == "Sheet1"
    assert (r.row1, r.col1, r.row2, r.col2) == (5, 2, 5, 2)
    assert r.is_whole_tab is False


def test_parse_range_rectangle() -> None:
    r = parse_range("Лист!A1:C3")
    assert r.tab == "Лист"
    assert (r.row1, r.col1, r.row2, r.col2) == (1, 1, 3, 3)


def test_parse_range_quoted_tab() -> None:
    r = parse_range("'My Sheet'!A1:B2")
    assert r.tab == "My Sheet"


def test_parse_range_quoted_tab_with_escape() -> None:
    r = parse_range("'O''Brien'!A1")
    assert r.tab == "O'Brien"


def test_parse_range_whole_tab() -> None:
    r = parse_range("Sheet1")
    assert r.tab == "Sheet1"
    assert r.is_whole_tab is True


def test_parse_range_open_ended_column() -> None:
    r = parse_range("S!A:A")
    assert r.tab == "S"
    assert (r.row1, r.col1, r.row2, r.col2) == (None, 1, None, 1)


def test_parse_range_open_ended_row() -> None:
    r = parse_range("S!1:5")
    assert r.tab == "S"
    assert (r.row1, r.col1, r.row2, r.col2) == (1, None, 5, None)


def test_parse_range_default_tab() -> None:
    r = parse_range("A1:B2", default_tab="Sheet1")
    assert r.tab == "Sheet1"
    assert (r.row1, r.col1, r.row2, r.col2) == (1, 1, 2, 2)


def test_parse_range_no_tab_no_default_fails() -> None:
    with pytest.raises(ValueError):
        parse_range("A1:B2")


def test_parse_range_empty_string() -> None:
    with pytest.raises(ValueError):
        parse_range("")


def test_parse_range_invalid_cell() -> None:
    with pytest.raises(ValueError):
        parse_range("S!@#")


def test_parse_range_only_colon() -> None:
    # `S!:` — обе стороны пустые, должно бросить.
    with pytest.raises(ValueError):
        parse_range("S!:")
