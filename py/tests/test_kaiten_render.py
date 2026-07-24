"""Тесты `mpu.lib.kaiten_render` — только чистые функции (без сети/терминала).

Сетевой `fetch_image_bytes` и терминальный `render_image` не покрываются (как I/O-клиент
miro/slapi). Здесь: notebook-split markdown по картинкам, извлечение URL, детект картинок,
декод data:-URI.
"""

from __future__ import annotations

import base64
import io

import httpx
import pytest
from rich.console import Console

from mpu.lib import kaiten_render
from mpu.lib.kaiten_render import (
    decode_data_uri,
    fetch_image_bytes,
    inline_image_urls,
    is_image_url,
    render_image,
    render_markdown_with_images,
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


# ── fetch_image_bytes: сеть мокируется на kaiten_render.httpx.get ────────────────
# Минимальный валидный 1×1 PNG — для реального term-image рендера ниже.
_PNG_1x1_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
_PNG_1x1 = base64.b64decode(_PNG_1x1_B64)


def _resp_ok(url: str, **_kwargs: object) -> httpx.Response:
    return httpx.Response(200, content=b"PNGBYTES", request=httpx.Request("GET", url))


def _resp_500(url: str, **_kwargs: object) -> httpx.Response:
    return httpx.Response(500, request=httpx.Request("GET", url))


def _raise_connect(url: str, **_kwargs: object) -> httpx.Response:
    raise httpx.ConnectError("boom")


def test_fetch_image_bytes_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kaiten_render.httpx, "get", _resp_ok)
    assert fetch_image_bytes("https://files.kaiten.ru/x.png") == b"PNGBYTES"


def test_fetch_image_bytes_status_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # 500 → raise_for_status → HTTPStatusError (подкласс HTTPError) → None.
    monkeypatch.setattr(kaiten_render.httpx, "get", _resp_500)
    assert fetch_image_bytes("https://files.kaiten.ru/x.png") is None


def test_fetch_image_bytes_connect_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kaiten_render.httpx, "get", _raise_connect)
    assert fetch_image_bytes("https://files.kaiten.ru/x.png") is None


# ── render_image: реальный term-image (детект→unicode-блоки вне терминала) ───────


def test_render_image_success_with_valid_png() -> None:
    # валидный PNG → AutoImage рисует (на не-терминале падает в unicode-блоки) → True.
    assert render_image(_PNG_1x1, max_width=10) is True


def test_render_image_garbage_returns_false() -> None:
    # битые байты → PIL.Image.open кидает → except → False (вызывающий печатает ссылку).
    assert render_image(b"not-a-png") is False


# ── render_markdown_with_images: notebook-flow (текст→rich, картинка→на месте) ───


def _render_to_buffer(md: str, *, images: bool) -> str:
    buf = io.StringIO()
    console = Console(file=buf, width=100, force_terminal=False, color_system=None)
    render_markdown_with_images(console, md, images=images)
    return buf.getvalue()


def test_render_markdown_images_off_falls_back_to_link() -> None:
    # images=False → картинка как кликабельная ссылка; пустой хвостовой текст пропускается.
    out = _render_to_buffer("intro\n![](https://f/a.png)\n", images=False)
    assert "intro" in out
    assert "🖼" in out
    assert "https://f/a.png" in out


def test_render_markdown_data_uri_renders_inline(capsys: pytest.CaptureFixture[str]) -> None:
    # images=True + валидный data:-PNG → _image_bytes(data:)→decode→render_image True →
    # рисуется на месте (в stdout), в буфере консоли фолбэк-ссылки НЕТ.
    out = _render_to_buffer(f"![](data:image/png;base64,{_PNG_1x1_B64})", images=True)
    assert "🖼" not in out
    capsys.readouterr()  # поглотить term-image вывод в stdout


def test_render_markdown_http_image_render_failure_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # images=True, http-URL → fetch вернул не-картинку → render_image False → фолбэк-ссылка.
    def _fetch_garbage(url: str, *, timeout: float = 15.0) -> bytes | None:
        return b"not-a-png"

    monkeypatch.setattr(kaiten_render, "fetch_image_bytes", _fetch_garbage)
    out = _render_to_buffer("![](https://f/a.png)", images=True)
    assert "🖼" in out
    assert "https://f/a.png" in out


def test_render_markdown_http_download_failed_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # images=True, http-URL → скачивание упало (None) → data None → фолбэк-ссылка.
    def _fetch_none(url: str, *, timeout: float = 15.0) -> bytes | None:
        return None

    monkeypatch.setattr(kaiten_render, "fetch_image_bytes", _fetch_none)
    out = _render_to_buffer("![](https://f/b.png)", images=True)
    assert "🖼" in out
    assert "https://f/b.png" in out
