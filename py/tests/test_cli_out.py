"""Тесты `lib/cli_out.py` — единый JSON-принтер."""

import pytest

from mpu.lib.cli_out import print_json


def test_print_json_unicode_and_indent(capsys: pytest.CaptureFixture[str]) -> None:
    print_json({"имя": "клиент", "ids": [1, 2]})
    captured = capsys.readouterr()
    assert captured.out == '{\n  "имя": "клиент",\n  "ids": [\n    1,\n    2\n  ]\n}\n'
    assert captured.err == ""


def test_print_json_scalar(capsys: pytest.CaptureFixture[str]) -> None:
    print_json(None)
    assert capsys.readouterr().out == "null\n"
