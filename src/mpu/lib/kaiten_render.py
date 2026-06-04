"""Терминальный рендер Kaiten-карточки: markdown через rich + инлайн-скриншоты.

«Notebook-flow»: markdown режется по узлам `![](url)` (`split_markdown_images`), текст
рендерится через `rich.markdown.Markdown` (он же рисует GFM-таблицы и кликабельные ссылки),
а картинки — через `term-image` ровно на своём месте. `term-image` сам детектит протокол
терминала (kitty graphics / sixel / iterm2) и падает в unicode-блоки на неподдерживающих —
так что отдельная capability-детекция не нужна.

Сеть (скачивание публичных `files.kaiten.ru/*.png`) и тяжёлые импорты (`PIL`/`term_image`)
изолированы здесь и грузятся лениво, чтобы `--md`/`--json` за них не платили, а поломанная
картинка/либа давала фолбэк-ссылку, а не падение всей команды.

Чистые функции (`split_markdown_images`, `inline_image_urls`, `is_image_url`,
`decode_data_uri`) — без сети/терминала, покрыты тестами.
"""

from __future__ import annotations

import base64
import re

import httpx
from rich.console import Console
from rich.markdown import Markdown

# `![alt](url)` где url — http(s) или data:-URI. Узлы скриншотов Kaiten всегда такого вида.
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+|data:[^)\s]+)\)")

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")


def is_image_url(url_or_name: str) -> bool:
    """Картинка ли это — по расширению (mime_type у Kaiten-файлов часто null)."""
    return url_or_name.lower().rsplit("?", 1)[0].endswith(_IMAGE_EXTS)


def split_markdown_images(md: str) -> list[tuple[str, str]]:
    """markdown → упорядоченные сегменты `("text", chunk)` / `("image", url)`.

    Текст между узлами `![](url)` сохраняется как есть (с таблицами), картинки выносятся
    отдельными сегментами на своих местах. Пустые текстовые сегменты не выкидываются —
    это делает рендер, чтобы функция оставалась чистой и предсказуемой в тестах.
    """
    segments: list[tuple[str, str]] = []
    pos = 0
    for m in _IMAGE_RE.finditer(md):
        segments.append(("text", md[pos : m.start()]))
        segments.append(("image", m.group(1)))
        pos = m.end()
    segments.append(("text", md[pos:]))
    return segments


def inline_image_urls(md: str) -> list[str]:
    """URL всех инлайн-картинок `![](url)` в порядке появления (для dedupe с files[])."""
    return _IMAGE_RE.findall(md)


def decode_data_uri(uri: str) -> bytes | None:
    """`data:image/png;base64,…` → bytes. Не-`data:` URI или битый base64 → None."""
    if not uri.startswith("data:"):
        return None
    try:
        return base64.b64decode(uri.split(",", 1)[1])
    except (ValueError, IndexError):
        return None


def fetch_image_bytes(url: str, *, timeout: float = 15.0) -> bytes | None:
    """Скачать публичный files.kaiten.ru/*.png (без auth). Любая ошибка → None."""
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=True)
        r.raise_for_status()
        return r.content
    except httpx.HTTPError:
        return None


def _image_bytes(url: str) -> bytes | None:
    """bytes картинки по http(s)-URL или data:-URI."""
    if url.startswith("data:"):
        return decode_data_uri(url)
    return fetch_image_bytes(url)


def render_image(data: bytes, *, max_width: int = 80) -> bool:
    """Нарисовать картинку через term-image (kitty/sixel/iterm2 → блоки). True — успех.

    Импорт `PIL`/`term_image` ленивый: пути `--md`/`--json` за него не платят, а отсутствие
    либы/битые байты → False (вызывающий печатает фолбэк-ссылку), не исключение.
    """
    try:
        import io
        import warnings

        # Фильтр ставится ДО загрузки term_image (требование либы): подавляем
        # «process is not running within a terminal», когда детекция терминала промахивается.
        warnings.filterwarnings(
            "ignore", message="It seems this process is not running within a terminal"
        )
        from PIL import Image

        # term-image без type-stubs (untyped third-party): протокол-детект + рендер.
        from term_image.image import (  # pyright: ignore[reportMissingTypeStubs]
            AutoImage,  # pyright: ignore[reportUnknownVariableType]
        )

        img = AutoImage(Image.open(io.BytesIO(data)), width=max_width)
        print(str(img))
        return True
    except Exception:
        return False


def render_markdown_with_images(
    console: Console, md: str, *, images: bool, max_width: int = 80
) -> None:
    """Notebook-flow: текстовые сегменты → rich.Markdown, картинки → term-image на месте.

    `images=False` (или неудача рендера) → картинка показывается кликабельной ссылкой,
    чтобы ничего не терялось на терминалах без графики / при ошибке скачивания.
    """
    for kind, value in split_markdown_images(md):
        if kind == "text":
            if value.strip():
                console.print(Markdown(value))
            continue
        data = _image_bytes(value) if images else None
        if data is not None and render_image(data, max_width=max_width):
            continue
        console.print(f"[link={value}]🖼 {value}[/link]")
