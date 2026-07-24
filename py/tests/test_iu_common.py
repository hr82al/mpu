"""Тесты `read_iu_input` — парсинг ИУ-входа `[{nm_id, perc}]` из payload/stdin.

Мокаем только seams: `sys.stdin` (через `io.StringIO`) и захват stderr через
`capsys` (туда пишет `typer.echo(..., err=True)`). Сеть/PG/процессы не задействованы.
"""

from __future__ import annotations

import io
import sys

import pytest
import typer

from mpu.lib.iu_common import read_iu_input

CMD = "mpu-iu-test"


def _set_stdin(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    """Подменить `sys.stdin` на буфер с заданным содержимым."""
    monkeypatch.setattr(sys, "stdin", io.StringIO(text))


# ── успешные разборы ─────────────────────────────────────────────────────────


def test_valid_single_item() -> None:
    """Один объект → один кортеж `(int, float)`."""
    rows = read_iu_input('[{"nm_id": 123, "perc": 34.72}]', command_name=CMD)
    assert rows == [(123, 34.72)]
    nm_id, perc = rows[0]
    assert isinstance(nm_id, int)
    assert isinstance(perc, float)


def test_valid_multiple_items_preserve_order() -> None:
    """Несколько объектов сохраняют порядок входа."""
    payload = '[{"nm_id": 1, "perc": 10}, {"nm_id": 2, "perc": 20.5}, {"nm_id": 3, "perc": 0}]'
    rows = read_iu_input(payload, command_name=CMD)
    assert rows == [(1, 10.0), (2, 20.5), (3, 0.0)]


def test_extra_fields_ignored() -> None:
    """Лишние ключи в объекте игнорируются, читаются только nm_id/perc."""
    payload = '[{"nm_id": 7, "perc": 5, "junk": "x", "perc_extra": 99}]'
    rows = read_iu_input(payload, command_name=CMD)
    assert rows == [(7, 5.0)]


def test_numeric_string_coercion() -> None:
    """Числа-строки приводятся: nm_id через int(), perc через float()."""
    rows = read_iu_input('[{"nm_id": "456", "perc": "34.72"}]', command_name=CMD)
    assert rows == [(456, 34.72)]


def test_float_nm_id_truncated() -> None:
    """nm_id-float молча усекается int()-ом (фиксируем поведение)."""
    rows = read_iu_input('[{"nm_id": 123.9, "perc": 1}]', command_name=CMD)
    assert rows == [(123, 1.0)]


def test_reads_stdin_when_payload_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """payload=None → вход читается из stdin."""
    _set_stdin(monkeypatch, '[{"nm_id": 999, "perc": 12.5}]')
    rows = read_iu_input(None, command_name=CMD)
    assert rows == [(999, 12.5)]


def test_payload_takes_precedence_over_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    """При заданном payload stdin не читается."""
    _set_stdin(monkeypatch, "STDIN MUST NOT BE READ")
    rows = read_iu_input('[{"nm_id": 1, "perc": 2}]', command_name=CMD)
    assert rows == [(1, 2.0)]


# ── пустой / отсутствующий вход ──────────────────────────────────────────────


@pytest.mark.parametrize("payload", ["", "   ", "\n\t  \n"])
def test_empty_or_whitespace_payload_exits(
    payload: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пустой / пробельный payload → Exit(2) с понятным сообщением."""
    with pytest.raises(typer.Exit) as exc:
        read_iu_input(payload, command_name=CMD)
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert CMD in err
    assert "пустой вход" in err


def test_empty_stdin_exits(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """payload=None и пустой stdin → Exit(2) (пустой вход)."""
    _set_stdin(monkeypatch, "   \n")
    with pytest.raises(typer.Exit) as exc:
        read_iu_input(None, command_name=CMD)
    assert exc.value.exit_code == 2
    assert "пустой вход" in capsys.readouterr().err


# ── невалидная структура JSON ────────────────────────────────────────────────


def test_malformed_json_exits(capsys: pytest.CaptureFixture[str]) -> None:
    """Битый JSON → Exit(2), сообщение про невалидный JSON."""
    with pytest.raises(typer.Exit) as exc:
        read_iu_input("[{not json", command_name=CMD)
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert CMD in err
    assert "невалидный JSON" in err


@pytest.mark.parametrize(
    "payload",
    [
        "{}",  # объект, не массив
        '{"nm_id": 1, "perc": 2}',  # одиночный объект, не массив
        "5",  # скаляр
        '"hello"',  # строка
        "null",  # null
        "[]",  # пустой массив
    ],
)
def test_not_a_nonempty_list_exits(payload: str, capsys: pytest.CaptureFixture[str]) -> None:
    """Не-список или пустой список → Exit(2)."""
    with pytest.raises(typer.Exit) as exc:
        read_iu_input(payload, command_name=CMD)
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert CMD in err
    assert "непустой JSON-массив" in err


# ── невалидные элементы массива ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "payload",
    [
        '[{"perc": 34.72}]',  # нет nm_id (KeyError)
        '[{"nm_id": 123}]',  # нет perc (KeyError)
        '[{"nm_id": "abc", "perc": 34.72}]',  # nm_id не приводится (ValueError)
        '[{"nm_id": 123, "perc": "xx"}]',  # perc не приводится (ValueError)
        "[5]",  # элемент не объект (TypeError)
        "[[1, 2]]",  # элемент-список (TypeError)
        '[{"nm_id": null, "perc": 1}]',  # nm_id None (TypeError)
        '[{"nm_id": 1, "perc": null}]',  # perc None (TypeError)
    ],
)
def test_bad_item_exits(payload: str, capsys: pytest.CaptureFixture[str]) -> None:
    """Любой нечитаемый элемент → Exit(2) с командой и отметкой '#'."""
    with pytest.raises(typer.Exit) as exc:
        read_iu_input(payload, command_name=CMD)
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert CMD in err
    assert "элемент #" in err


def test_bad_item_reports_offending_index() -> None:
    """Индекс битого элемента — в сообщении (первый валиден, второй битый → #1)."""
    payload = '[{"nm_id": 1, "perc": 2}, {"nm_id": "bad"}]'
    with pytest.raises(typer.Exit) as exc:
        read_iu_input(payload, command_name=CMD)
    assert exc.value.exit_code == 2


def test_bad_item_message_includes_index_and_repr(capsys: pytest.CaptureFixture[str]) -> None:
    """Сообщение об ошибке элемента содержит индекс #1 и repr самого элемента."""
    payload = '[{"nm_id": 1, "perc": 2}, {"nm_id": "bad", "perc": 3}]'
    with pytest.raises(typer.Exit):
        read_iu_input(payload, command_name=CMD)
    err = capsys.readouterr().err
    assert "элемент #1" in err
    assert "'bad'" in err


def test_error_uses_supplied_command_name(capsys: pytest.CaptureFixture[str]) -> None:
    """В сообщениях об ошибке фигурирует именно переданный command_name."""
    custom = "mpu iu-wb fix-formulas"
    with pytest.raises(typer.Exit):
        read_iu_input("", command_name=custom)
    assert custom in capsys.readouterr().err
