"""Тесты `lib/cli_err.py` — единый форматтер машинно-читаемых CLI-ошибок."""

import pytest

from mpu.lib.cli_err import die, fail


def test_fail_reason_only(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc_info:
        fail("mpu foo", "не найден клиент", code=2)
    assert exc_info.value.code == 2
    captured = capsys.readouterr()
    assert captured.err == "mpu foo: не найден клиент\n"
    assert captured.out == ""


def test_fail_with_hint(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        fail("mpu foo", "пустой селектор", code=1, hint="передай --client-id <id>")
    captured = capsys.readouterr()
    assert captured.err == "mpu foo: пустой селектор; попробуй: передай --client-id <id>\n"


def test_fail_with_extra(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        fail("mpu foo", "неоднозначный селектор", code=2, extra="кандидаты:\n  1\n  2")
    captured = capsys.readouterr()
    assert captured.err == "mpu foo: неоднозначный селектор\nкандидаты:\n  1\n  2\n"


def test_fail_empty_extra_not_printed(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        fail("mpu foo", "ошибка", code=1, extra=None)
    captured = capsys.readouterr()
    assert captured.err == "mpu foo: ошибка\n"


def test_die_default_code(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc_info:
        die("mpu bar sub: сеть недоступна")
    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert captured.err == "mpu bar sub: сеть недоступна\n"


def test_die_custom_code(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc_info:
        die("mpu bar: bad usage", code=2)
    assert exc_info.value.code == 2
    assert capsys.readouterr().err == "mpu bar: bad usage\n"
