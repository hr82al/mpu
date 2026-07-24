"""Тесты `mpu kiten comment` — комментарий, вложения, адресаты.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import typer

from kiten_fakes import FakeKaitenClient, card_detail, install_client, runner
from mpu.commands.kiten import (
    app,
    expand_recipients,
    field as kiten_field,
    parse_recipients,
    prepend_recipients,
    read_attachments,
    resolve_comment_text,
)
from mpu.lib.kaiten import (
    build_multipart,
)

# ── resolve_comment_text: тело из ровно одного источника (-m / -F / stdin) ───────


def _no_stdin() -> str:
    raise AssertionError("stdin не должен читаться без `-F -`")


def test_resolve_comment_text_message() -> None:
    assert resolve_comment_text("привет", None, stdin_read=_no_stdin) == "привет"


def test_resolve_comment_text_file(tmp_path: Path) -> None:
    body_file = tmp_path / "body.md"
    body_file.write_text("**из файла**", encoding="utf-8")
    assert resolve_comment_text(None, str(body_file), stdin_read=_no_stdin) == "**из файла**"


def test_resolve_comment_text_stdin() -> None:
    assert resolve_comment_text(None, "-", stdin_read=lambda: "из stdin") == "из stdin"


def test_resolve_comment_text_exactly_one_source() -> None:
    # ни одного источника...
    with pytest.raises(typer.BadParameter):
        resolve_comment_text(None, None, stdin_read=_no_stdin)
    # ...и оба сразу — оба запрещены.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("a", "-", stdin_read=_no_stdin)


def test_resolve_comment_text_empty_and_missing_file(tmp_path: Path) -> None:
    # пустое тело (только пробелы) → ошибка.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("   \n", None, stdin_read=_no_stdin)
    # несуществующий файл → BadParameter, не OSError наружу.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text(None, str(tmp_path / "nope.md"), stdin_read=_no_stdin)


def test_resolve_comment_text_optional_with_attachments() -> None:
    # есть вложения (require_text=False): оба источника опущены → пустой текст, не ошибка.
    assert resolve_comment_text(None, None, stdin_read=_no_stdin, require_text=False) == ""
    # текст при этом всё ещё можно передать.
    assert (
        resolve_comment_text("подпись", None, stdin_read=_no_stdin, require_text=False) == "подпись"
    )
    # оба источника сразу запрещены даже с вложениями.
    with pytest.raises(typer.BadParameter):
        resolve_comment_text("a", "-", stdin_read=_no_stdin, require_text=False)


# ── read_attachments: пути → (имя, байты); понятная ошибка на промахе ────────────


def test_read_attachments_reads_in_order(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    a.write_text("# A", encoding="utf-8")
    b = tmp_path / "b.bin"
    b.write_bytes(b"\x00\x01\x02")
    got = read_attachments([str(a), str(b)])
    assert got == [("a.md", b"# A"), ("b.bin", b"\x00\x01\x02")]


def test_read_attachments_missing_file(tmp_path: Path) -> None:
    with pytest.raises(typer.BadParameter):
        read_attachments([str(tmp_path / "nope.png")])


def test_read_attachments_directory_is_not_a_file(tmp_path: Path) -> None:
    with pytest.raises(typer.BadParameter):
        read_attachments([str(tmp_path)])


# ── build_multipart: текст + файлы под именем files[] ───────────────────────────


def test_build_multipart_text_and_files() -> None:
    body, content_type = build_multipart(
        {"text": "привет"}, [("one.txt", b"ONE"), ("two.md", b"# TWO")]
    )
    assert content_type.startswith("multipart/form-data; boundary=")
    boundary = content_type.split("boundary=", 1)[1]
    assert boundary.encode() in body
    # текстовое поле и оба файла под одним именем files[].
    assert b'name="text"' in body
    assert b"\r\n\r\n\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82\r\n" in body  # utf-8 «привет»
    assert body.count(b'name="files[]"') == 2
    assert b'filename="one.txt"' in body
    assert b'filename="two.md"' in body
    assert b"ONE" in body
    assert b"# TWO" in body
    # корректный завершающий разделитель.
    assert body.rstrip(b"\r\n").endswith(f"--{boundary}--".encode())


def test_build_multipart_sanitizes_filename() -> None:
    body, _ = build_multipart({}, [('a"b\n.txt', b"x")])
    assert b'filename="a%22b .txt"' in body


def test_build_multipart_custom_file_field() -> None:
    # Загрузка файла карточки: поле называется `file` (не `files[]`) + текстовый custom_property_id.
    body, _ = build_multipart(
        {"custom_property_id": "610303"}, [("a.md", b"# A")], file_field="file"
    )
    assert b'name="custom_property_id"' in body
    assert b'name="file"; filename="a.md"' in body
    assert b'name="files[]"' not in body
    assert b"# A" in body


def test_is_markdown() -> None:
    assert kiten_field._is_markdown("67531635-slug.md")
    assert kiten_field._is_markdown("UPPER.MD")
    assert not kiten_field._is_markdown("report.txt")
    assert not kiten_field._is_markdown("noext")


# ── --to адресаты: разбор, раскрытие @all, постановка строкой в начало ───────────


def test_parse_recipients_flatten_normalize_dedup() -> None:
    # повторяемый + значения через пробел; ведущая @ добавляется; дубли (регистр) убираются.
    assert parse_recipients(["@all @ivan", "petr", "@IVAN"]) == ["@all", "@ivan", "@petr"]
    assert parse_recipients([]) == []


def test_expand_recipients_all_to_owner() -> None:
    line, mentioned = expand_recipients(["@all", "@ivan"], "ownerlogin")
    assert line == "@ownerlogin @ivan"
    assert mentioned == ["ownerlogin", "ivan"]


def test_expand_recipients_all_dedup_with_explicit_owner() -> None:
    # @all → owner, а owner уже указан явно — без дубля.
    line, mentioned = expand_recipients(["@all", "@ownerlogin"], "ownerlogin")
    assert line == "@ownerlogin"
    assert mentioned == ["ownerlogin"]


def test_expand_recipients_no_owner_keeps_all_literal() -> None:
    line, mentioned = expand_recipients(["@all", "@ivan"], None)
    assert line == "@all @ivan"
    # @all не резолвится → в список упомянутых логинов не попадает.
    assert mentioned == ["ivan"]


def test_prepend_recipients_separate_line() -> None:
    assert prepend_recipients("привет", "@ivan") == "@ivan\n\nпривет"
    # пустой текст → только строка адресатов.
    assert prepend_recipients("   ", "@ivan") == "@ivan"
    # нет адресатов → текст без изменений.
    assert prepend_recipients("привет", "") == "привет"


# ── comment ─────────────────────────────────────────────────────────────────────


def test_comment_message(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "привет"])
    assert res.exit_code == 0, res.stderr
    assert "ok: комментарий 777 → https://btlz.kaiten.ru/100" in res.output
    assert fake.added_comments == [{"card_id": 100, "text": "привет", "files": None}]
    assert fake.get_card_ids == []  # владелец не нужен → get_card не звался


def test_comment_body_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    body = tmp_path / "body.md"
    body.write_text("**из файла**", encoding="utf-8")
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-F", str(body)])
    assert res.exit_code == 0, res.stderr
    assert fake.added_comments[0]["text"] == "**из файла**"


def test_comment_with_attachments(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    att = tmp_path / "a.png"
    att.write_bytes(b"\x89PNG")
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-f", str(att)])
    assert res.exit_code == 0, res.stderr
    assert "вложения: a.png" in res.output
    files = fake.added_comments[0]["files"]
    assert files == [("a.png", b"\x89PNG")]


def test_comment_to_all_expands_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(owner_username="ownerlogin")])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "ответ", "--to", "@all"])
    assert res.exit_code == 0, res.stderr
    assert "адресаты: @ownerlogin" in res.output
    text = fake.added_comments[0]["text"]
    assert isinstance(text, str)
    assert text.startswith("@ownerlogin")


def test_comment_to_all_no_owner_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(owner_username=None)])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "ответ", "--to", "@all"])
    assert res.exit_code == 0, res.stderr
    assert "нет владельца" in res.stderr


def test_comment_all_mention_in_text(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(details=[card_detail(owner_username="ownerlogin")])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["comment", "100", "-m", "@all внимание"])
    assert res.exit_code == 0, res.stderr
    text = fake.added_comments[0]["text"]
    assert text == "@ownerlogin внимание"


def test_comment_no_text_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["comment", "100"])
    assert res.exit_code == 2
    assert "ровно одно" in res.stderr


def test_comment_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, FakeKaitenClient(fail={"add_comment"}))
    res = runner.invoke(app, ["comment", "100", "-m", "x"])
    assert res.exit_code == 1
    assert "comment: kaiten error" in res.stderr
