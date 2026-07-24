"""Тесты `lib/cli_err.py` — единый форматтер машинно-читаемых CLI-ошибок."""

import pytest

from mpu.lib.cli_err import bind, die, fail


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


def test_bind_fixes_command_prefix(capsys: pytest.CaptureFixture[str]) -> None:
    """`bind` — тот же `fail` с зафиксированным именем команды."""
    fail_here = bind("mpu foo")
    with pytest.raises(SystemExit) as exc_info:
        fail_here("не найден клиент", code=2)
    assert exc_info.value.code == 2
    assert capsys.readouterr().err == "mpu foo: не найден клиент\n"


def test_bind_defaults_to_code_1(capsys: pytest.CaptureFixture[str]) -> None:
    """Без явного `code` — выход с 1 (как у `die`)."""
    with pytest.raises(SystemExit) as exc_info:
        bind("mpu foo")("сеть недоступна")
    assert exc_info.value.code == 1
    assert capsys.readouterr().err == "mpu foo: сеть недоступна\n"


def test_bind_passes_hint_and_extra(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        bind("mpu foo")("неоднозначный селектор", code=2, hint="уточни", extra="  cid=1\n  cid=2")
    captured = capsys.readouterr()
    assert captured.err == "mpu foo: неоднозначный селектор; попробуй: уточни\n  cid=1\n  cid=2\n"
