"""Тесты `mpu mr` — только чистые функции (без сети, без git, без HTTP-моков).

I/O (GitLabClient, subprocess git, _resolve_target) тестами не покрыт — прецедент
kaiten. Здесь: разбор FILE:LINE, выбор источника тела, метка позиции, excerpt и
текст ошибки «строка вне диффа».
"""

from __future__ import annotations

from pathlib import Path

import pytest
import typer

from mpu.commands.mr import (
    excerpt,
    line_not_in_diff_message,
    parse_location,
    position_label,
    resolve_body,
)
from mpu.lib.gitlab_mr import FileDiff, NotePosition


def _no_stdin() -> str:
    raise AssertionError("stdin не должен читаться")


# ── parse_location ──────────────────────────────────────────────────────────────


def test_parse_location_ok():
    assert parse_location("src/a.js:64") == ("src/a.js", 64)


def test_parse_location_path_with_colon():
    assert parse_location("C:src/a.js:5") == ("C:src/a.js", 5)


@pytest.mark.parametrize("bad", ["src/a.js", ":5", "src/a.js:", "src/a.js:0", "src/a.js:x"])
def test_parse_location_bad(bad: str):
    with pytest.raises(typer.BadParameter):
        parse_location(bad)


# ── resolve_body ────────────────────────────────────────────────────────────────


def test_resolve_body_message():
    assert resolve_body("текст", None, stdin_read=_no_stdin) == "текст"


def test_resolve_body_file(tmp_path: Path):
    body_file = tmp_path / "body.md"
    body_file.write_text("**из файла**", encoding="utf-8")
    assert resolve_body(None, str(body_file), stdin_read=_no_stdin) == "**из файла**"


def test_resolve_body_stdin():
    assert resolve_body(None, "-", stdin_read=lambda: "из stdin") == "из stdin"


def test_resolve_body_exactly_one_source():
    with pytest.raises(typer.BadParameter, match="ровно одно"):
        resolve_body(None, None, stdin_read=_no_stdin)
    with pytest.raises(typer.BadParameter, match="ровно одно"):
        resolve_body("a", "-", stdin_read=_no_stdin)


def test_resolve_body_empty_and_missing_file(tmp_path: Path):
    with pytest.raises(typer.BadParameter, match="пустое"):
        resolve_body("   \n", None, stdin_read=_no_stdin)
    with pytest.raises(typer.BadParameter, match="не удалось прочитать"):
        resolve_body(None, str(tmp_path / "nope.md"), stdin_read=_no_stdin)


# ── position_label / excerpt ────────────────────────────────────────────────────


def test_position_label_variants():
    assert position_label(None) == ""
    new_side = NotePosition(old_path="a", new_path="src/a.js", old_line=None, new_line=64)
    assert position_label(new_side) == "src/a.js:64"
    old_side = NotePosition(old_path="src/a.js", new_path=None, old_line=60, new_line=None)
    assert position_label(old_side) == "src/a.js:60 (old)"
    path_only = NotePosition(old_path=None, new_path="src/a.js", old_line=None, new_line=None)
    assert position_label(path_only) == "src/a.js"


def test_excerpt():
    assert excerpt("первая строка\nвторая") == "первая строка"
    assert excerpt("  \n\nтело") == "тело"
    assert excerpt("") == ""
    long = "x" * 100
    assert excerpt(long, width=10) == "x" * 9 + "…"


# ── line_not_in_diff_message ────────────────────────────────────────────────────


def _file_diff(diff: str, *, deleted: bool = False) -> FileDiff:
    return FileDiff(
        old_path="src/a.js",
        new_path="src/a.js",
        diff=diff,
        new_file=False,
        renamed_file=False,
        deleted_file=deleted,
    )


def test_line_not_in_diff_lists_ranges():
    fd = _file_diff("@@ -10,2 +10,3 @@\n ctx\n+a\n+b\n")
    message = line_not_in_diff_message(fd, "src/a.js", 500, "new")
    assert "src/a.js:500" in message
    assert "10-12" in message
    assert "--old" in message


def test_line_not_in_diff_deleted_file_hints_old():
    fd = _file_diff("@@ -1,2 +0,0 @@\n-a\n-b\n", deleted=True)
    message = line_not_in_diff_message(fd, "src/a.js", 1, "new")
    assert "удалён" in message
    assert "--old" in message


def test_line_not_in_diff_empty_side():
    fd = _file_diff("@@ -0,0 +1,2 @@\n+a\n+b\n")
    message = line_not_in_diff_message(fd, "src/a.js", 5, "old")
    assert "нет комментируемых строк" in message
