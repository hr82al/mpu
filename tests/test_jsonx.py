"""Тесты `lib/jsonx.py` — общие type-guard'ы JSON-границ."""

from mpu.lib import jsonx


def test_is_dict() -> None:
    assert jsonx.is_dict({}) is True
    assert jsonx.is_dict({"a": 1}) is True
    assert jsonx.is_dict([]) is False
    assert jsonx.is_dict(None) is False


def test_is_list() -> None:
    assert jsonx.is_list([]) is True
    assert jsonx.is_list([1]) is True
    assert jsonx.is_list({}) is False
    assert jsonx.is_list("x") is False


def test_dict_items_filters_non_dicts() -> None:
    assert jsonx.dict_items([{"a": 1}, "мусор", 2, {"b": 3}]) == [{"a": 1}, {"b": 3}]


def test_dict_items_non_list_is_empty() -> None:
    assert jsonx.dict_items(None) == []
    assert jsonx.dict_items({"a": 1}) == []
    assert jsonx.dict_items("строка") == []
