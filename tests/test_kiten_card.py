"""Тесты `mpu kiten card` — чтение карточки и её рендер.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from kiten_fakes import FakeKaitenClient, card_detail, install_client, patch_prop_names, runner
from mpu.commands.kiten import (
    _card_to_markdown,  # pyright: ignore[reportPrivateUsage]
    app,
    card as kiten_card,
)
from mpu.lib import kaiten_render
from mpu.lib.kaiten import (
    KaitenCardDetail,
    KaitenComment,
    KaitenFile,
    KaitenMember,
    parse_card_detail,
    parse_card_ref,
    parse_comment,
    parse_custom_property,
    parse_file,
    parse_member,
)

# ── parse_card_ref: селектор (id / короткий URL / глубокий URL) → id ────────────


@pytest.mark.parametrize(
    "ref",
    [
        "65634936",
        "  65634936  ",
        "https://btlz.kaiten.ru/65634936",
        "https://btlz.kaiten.ru/space/286794/boards/card/65634936?filter=eyJrZXk",
    ],
)
def test_parse_card_ref_valid(ref: str) -> None:
    # глубокий URL: берём ПОСЛЕДНИЙ числовой сегмент (карточку, не space 286794).
    assert parse_card_ref(ref) == 65634936


@pytest.mark.parametrize("ref", ["", "not-a-card", "https://btlz.kaiten.ru/spaces"])
def test_parse_card_ref_invalid(ref: str) -> None:
    with pytest.raises(ValueError, match="не удалось извлечь id"):
        parse_card_ref(ref)


# ── parse_card_detail / parse_member / parse_file / parse_comment / property ─────


def test_parse_card_detail_full() -> None:
    raw = {
        "id": 100,
        "key": "ABC-1",
        "title": "T",
        "state": 2,
        "condition": 1,
        "due_date": "2026-06-30T00:00:00Z",
        "board_id": 7,
        "board": {"id": 7, "title": "Board7"},
        "column_id": 9,
        "column": {"id": 9, "title": "Col9"},
        "lane": {"title": "Lane"},
        "type": {"title": "Bug"},
        "size_text": "M",
        "created": "2026-01-01",
        "updated": "2026-02-02",
        "description": "desc",
        "tags": [{"name": "OZON"}, {"name": "WB"}],
        "owner": {"id": 1, "full_name": "Owner", "email": "o@x", "username": "own"},
        "members": [{"id": 2, "full_name": "Mem", "email": "m@x", "username": "mem"}],
        "files": [{"id": 5, "url": "https://files/x.png", "name": "x.png", "comment_id": None}],
        "properties": {"id_1": "val", "id_2": "https://link", "id_3": None},
    }
    d = parse_card_detail(raw, "https://btlz.kaiten.ru")
    assert (d.id, d.key, d.title, d.state) == (100, "ABC-1", "T", 2)
    assert (d.board_title, d.column_title, d.lane_title) == ("Board7", "Col9", "Lane")
    assert d.type_name == "Bug"
    assert d.tags == ["OZON", "WB"]
    assert d.owner is not None
    assert d.owner.full_name == "Owner"
    assert [m.full_name for m in d.members] == ["Mem"]
    assert d.files[0].url == "https://files/x.png"
    # None-значения свойств отбрасываются; строковые/ссылки сохраняются.
    assert d.properties == {"id_1": "val", "id_2": "https://link"}
    assert d.url == "https://btlz.kaiten.ru/100"


def test_parse_card_detail_minimal() -> None:
    d = parse_card_detail({"id": 1}, "https://btlz.kaiten.ru")
    assert d.id == 1
    assert d.title == ""
    assert d.key is None
    assert d.description is None
    assert d.board_title is None
    assert d.owner is None
    assert d.tags == []
    assert d.members == []
    assert d.files == []
    assert d.properties == {}


def test_parse_member_and_file_and_comment() -> None:
    m = parse_member({"id": 5, "full_name": "A", "email": "a@x", "username": "au"})
    assert (m.id, m.full_name, m.email, m.username) == (5, "A", "a@x", "au")

    f = parse_file({"id": 1, "url": "u", "name": "n", "comment_id": None, "card_cover": True})
    assert f.comment_id is None
    assert f.card_cover is True
    assert f.mime_type is None  # часто отсутствует в API

    c = parse_comment(
        {"id": 9, "text": "hi", "author": {"full_name": "Bob"}, "created": "2026-06-03T06:39:25Z"}
    )
    assert (c.id, c.text, c.author_name, c.created) == (9, "hi", "Bob", "2026-06-03T06:39:25Z")


def test_parse_custom_property() -> None:
    p = parse_custom_property({"id": 542506, "name": "Описание", "type": "string"})
    assert (p.id, p.name, p.type) == (542506, "Описание", "string")


# ── _card_to_markdown: таблицы/ссылки дословно, имена свойств зарезолвлены ───────


def test_card_to_markdown_preserves_tables_links_and_resolves_props() -> None:
    detail = KaitenCardDetail(
        id=1,
        key=None,
        title="Title",
        state=2,
        condition=1,
        due_date=None,
        board_id=7,
        board_title="B",
        column_id=9,
        column_title="C",
        lane_title=None,
        size_text=None,
        created=None,
        updated=None,
        type_name=None,
        description="| A | B |\n|---|---|\n| 1 | 2 |",
        owner=None,
        url="https://btlz.kaiten.ru/1",
        tags=[],
        members=[],
        files=[
            KaitenFile(
                id=5,
                url="https://files/x.png",
                name="x.png",
                mime_type=None,
                comment_id=None,
                card_cover=False,
            )
        ],
        properties={"id_398965": "https://gitlab/mr/1"},
    )
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    md = _card_to_markdown(detail, comments, {398965: "Ссылка на Pull Request"})
    assert "# Title" in md
    assert "| A | B |" in md  # таблица из описания — дословно
    assert "|---|---|" in md
    assert "- [x.png](https://files/x.png)" in md  # файл как markdown-ссылка
    assert "- Ссылка на Pull Request: https://gitlab/mr/1" in md  # имя свойства зарезолвлено
    assert "### Bob · 2026-06-03 06:39" in md  # шапка комментария
    assert "hello" in md


# ── card ────────────────────────────────────────────────────────────────────────


def _rich_detail() -> KaitenCardDetail:
    return KaitenCardDetail(
        id=100,
        key="ABC-1",
        title="Title",
        state=2,
        condition=1,
        due_date="2026-06-30T00:00:00Z",
        board_id=7,
        board_title="Board7",
        column_id=9,
        column_title="Col9",
        lane_title="Lane",
        size_text="M",
        created="2026-01-01",
        updated="2026-02-02",
        type_name="Bug",
        description="| A | B |\n|---|---|\n| 1 | 2 |",
        owner=KaitenMember(id=1, full_name="Owner", email="o@x", username="own"),
        url="https://btlz.kaiten.ru/100",
        tags=["OZON"],
        members=[KaitenMember(id=2, full_name="Mem", email="m@x", username="mem")],
        files=[],
        properties={"id_398965": "https://gitlab/mr/1"},
    )


def test_card_json(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_prop_names(monkeypatch, {})
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], comments=comments))
    res = runner.invoke(app, ["card", "100", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: dict[str, Any] = json.loads(res.output)
    assert payload["id"] == 100
    assert payload["title"] == "Title"
    assert payload["comments"][0]["text"] == "hello"


def test_card_markdown_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # Под CliRunner stdout не tty → дефолт даёт markdown (без rich/term-image).
    patch_prop_names(monkeypatch, {398965: "Ссылка на Pull Request"})
    comments = [
        KaitenComment(id=2, text="hello", author_name="Bob", created="2026-06-03T06:39:25Z")
    ]
    install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], comments=comments))
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 0, res.stderr
    assert "# Title" in res.output
    assert "Ссылка на Pull Request: https://gitlab/mr/1" in res.output
    assert "### Bob · 2026-06-03 06:39" in res.output


def test_card_no_comments(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_prop_names(monkeypatch, {})
    fake = FakeKaitenClient(details=[_rich_detail()], comments=[])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["card", "100", "--md", "--no-comments"])
    assert res.exit_code == 0, res.stderr
    assert "## Комментарии" not in res.output


def test_card_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_prop_names(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(details=[_rich_detail()], fail={"get_card"}))
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 1
    assert "card: kaiten error" in res.stderr


def test_card_bad_selector_exits_2() -> None:
    res = runner.invoke(app, ["card", "not-a-card"])
    assert res.exit_code == 2
    assert "не удалось извлечь id" in res.stderr


# ── card: наглядный rich-рендер (TTY) ───────────────────────────────────────────


class _FakeStdout:
    @staticmethod
    def isatty() -> bool:
        return True


class _FakeSys:
    """Подмена `kiten.sys` для card: stdout.isatty() == True → ветка rich-рендера."""

    stdout = _FakeStdout()


def _patch_render(monkeypatch: pytest.MonkeyPatch, *, image_ok: bool = True) -> None:
    """No-op заглушки kaiten_render (без term-image/сети): картинки рендерятся «успешно»."""

    def _render_md(console: object, md: str, *, images: bool, max_width: int = 80) -> None:
        _ = (console, md, images, max_width)

    def _inline(md: str) -> list[str]:
        _ = md
        return []

    def _is_image(url_or_name: str) -> bool:
        return url_or_name.endswith(".png")

    def _fetch(url: str, *, timeout: float = 15.0) -> bytes | None:
        _ = (url, timeout)
        return b"PNGDATA"

    def _render_image(data: bytes, *, max_width: int = 80) -> bool:
        _ = (data, max_width)
        return image_ok

    monkeypatch.setattr(kaiten_render, "render_markdown_with_images", _render_md)
    monkeypatch.setattr(kaiten_render, "inline_image_urls", _inline)
    monkeypatch.setattr(kaiten_render, "is_image_url", _is_image)
    monkeypatch.setattr(kaiten_render, "fetch_image_bytes", _fetch)
    monkeypatch.setattr(kaiten_render, "render_image", _render_image)


def _detail_with_image() -> KaitenCardDetail:
    return KaitenCardDetail(
        id=100,
        key="ABC-1",
        title="Title",
        state=2,
        condition=1,
        due_date="2026-06-30T00:00:00Z",
        board_id=7,
        board_title="Board7",
        column_id=9,
        column_title="Col9",
        lane_title="Lane",
        size_text="M",
        created="2026-01-01",
        updated="2026-02-02",
        type_name="Bug",
        description="desc",
        owner=KaitenMember(id=1, full_name="Owner", email="o@x", username="own"),
        url="https://btlz.kaiten.ru/100",
        tags=["OZON"],
        members=[KaitenMember(id=2, full_name="Mem", email="m@x", username="mem")],
        files=[
            KaitenFile(
                id=5,
                url="https://files/pic.png",
                name="pic.png",
                mime_type="image/png",
                comment_id=None,
                card_cover=False,
            )
        ],
        properties={"id_398965": "https://gitlab/mr/1"},
    )


def test_card_rich_render_full(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kiten_card, "sys", _FakeSys)
    _patch_render(monkeypatch, image_ok=True)
    patch_prop_names(monkeypatch, {398965: "Ссылка на PR"})
    comments = [KaitenComment(id=2, text="hi", author_name="Bob", created="2026-06-03T06:39:25Z")]
    install_client(monkeypatch, FakeKaitenClient(details=[_detail_with_image()], comments=comments))
    res = runner.invoke(app, ["card", "100"])
    assert res.exit_code == 0, res.stderr
    assert "Title" in res.output  # шапка-панель отрисована


def test_card_rich_render_no_images(monkeypatch: pytest.MonkeyPatch) -> None:
    # --no-images → fetch не зовётся, вложение-картинка показывается ссылкой (ветка fallback).
    monkeypatch.setattr(kiten_card, "sys", _FakeSys)
    _patch_render(monkeypatch, image_ok=False)
    patch_prop_names(monkeypatch, {})
    install_client(monkeypatch, FakeKaitenClient(details=[_detail_with_image()], comments=[]))
    res = runner.invoke(app, ["card", "100", "--no-images"])
    assert res.exit_code == 0, res.stderr
    assert "files/pic.png" in res.output  # ссылка на вложение


def test_card_markdown_nonnumeric_property(monkeypatch: pytest.MonkeyPatch) -> None:
    # Ключ свойства не `id_<число>` → имя поля = сырой ключ (ветка ValueError в _format_property).
    patch_prop_names(monkeypatch, {})
    detail = card_detail(properties={"id_xx": "значение"})
    install_client(monkeypatch, FakeKaitenClient(details=[detail], comments=[]))
    res = runner.invoke(app, ["card", "100", "--md"])
    assert res.exit_code == 0, res.stderr
    assert "- id_xx: значение" in res.output
