"""Тесты `mpu.lib.kaiten_render` — только чистые функции (без сети/терминала).

Сетевой `fetch_image_bytes` и терминальный `render_image` не покрываются (как I/O-клиент
miro/slapi). Здесь: notebook-split markdown по картинкам, извлечение URL, детект картинок,
декод data:-URI.
"""

from __future__ import annotations

import base64

import pytest

from mpu.lib.kaiten_render import (
    decode_data_uri,
    inline_image_urls,
    is_image_url,
    split_markdown_images,
)

# ── split_markdown_images: чередование text/image в порядке ─────────────────────


def test_split_markdown_images_interleaves() -> None:
    md = "intro\n![](https://f/a.png)\nmiddle\n![alt](https://f/b.png)\nend"
    segs = split_markdown_images(md)
    assert [k for k, _ in segs] == ["text", "image", "text", "image", "text"]
    assert segs[1] == ("image", "https://f/a.png")
    assert segs[3] == ("image", "https://f/b.png")
    assert segs[0][1] == "intro\n"
    assert segs[-1][1] == "\nend"


def test_split_markdown_images_no_images() -> None:
    assert split_markdown_images("just text") == [("text", "just text")]


def test_split_markdown_images_data_uri() -> None:
    segs = split_markdown_images("![](data:image/png;base64,AAAA)")
    assert segs[1] == ("image", "data:image/png;base64,AAAA")


# ── inline_image_urls ───────────────────────────────────────────────────────────


def test_inline_image_urls() -> None:
    md = "![](https://f/a.png) x ![alt](https://f/b.png)"
    assert inline_image_urls(md) == ["https://f/a.png", "https://f/b.png"]


def test_inline_image_urls_none() -> None:
    assert inline_image_urls("no images here") == []


# ── is_image_url: по расширению (mime_type у Kaiten часто null) ──────────────────


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("x.png", True),
        ("X.JPG", True),
        ("a.jpeg", True),
        ("img.webp", True),
        ("pic.gif", True),
        ("https://files.kaiten.ru/uuid.png?x=1", True),  # query отбрасывается
        ("doc.pdf", False),
        ("noext", False),
    ],
)
def test_is_image_url(name: str, expected: bool) -> None:
    assert is_image_url(name) is expected


# ── decode_data_uri ─────────────────────────────────────────────────────────────


def test_decode_data_uri_roundtrip() -> None:
    raw = b"\x89PNG\r\n\x1a\n"
    uri = "data:image/png;base64," + base64.b64encode(raw).decode()
    assert decode_data_uri(uri) == raw


def test_decode_data_uri_non_data_uri() -> None:
    assert decode_data_uri("https://f/a.png") is None


def test_decode_data_uri_malformed() -> None:
    assert decode_data_uri("data:image/png;base64,!!!not-base64!!!") is None
