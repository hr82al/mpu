"""Парсинг d2-исходника и SVG для конвертации в Miro shapes/connectors.

Разделение ролей:
- d2 source даёт shape kinds (rectangle/cloud/cylinder/hexagon/page/...) и иерархию
  родителей (`triggers.dataLoader` имеет родителем `triggers`).
- SVG даёт layout — координаты x/y/w/h и точные эндпоинты edges, потому что d2
  делает layout сам (dagre/elk) и отдаёт только готовый рендер.

Каждая `<g>` в d2-SVG имеет class = base64(d2 path), это и есть стабильный ключ.
"""

from __future__ import annotations

import base64
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Literal

NS = "{http://www.w3.org/2000/svg}"


@dataclass
class D2Shape:
    """Описание шейпа из d2-исходника."""

    kind: str  # rectangle, cloud, cylinder, hexagon, page, markdown, card, ...
    label: str
    fill: str | None  # hex color from style.fill, если задан в исходнике
    stroke: str | None = None  # hex / "transparent" / "none" из style.stroke


@dataclass
class LayoutShape:
    """Положение шейпа из SVG (после layout d2)."""

    x: float
    y: float
    w: float
    h: float
    label: str
    fill: str | None  # из rect/path в SVG


@dataclass
class Edge:
    src: str
    dst: str
    label: str


# ---------- d2 source parser ----------


def _unescape(s: str) -> str:
    """Развернуть escape-последовательности в d2-string-литерале (`\\n`, `\\t`,
    `\\"`, `\\\\`). d2 в SVG рендерит их как реальные newline'ы (через tspan),
    поэтому при чтении напрямую из d2-source нужно сделать то же — иначе
    дальнейшая обработка label'а (partition по \\n, html-конвертация) не сработает."""
    return (
        s.replace("\\\\", "\x00")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace('\\"', '"')
        .replace("\x00", "\\")
    )


def _skip_braced_block(lines: list[str], i: int, *, depth: int = 0) -> int:
    """Пропустить `{ ... }`-блок: скан от `lines[i]` с начальной глубиной `depth`,
    вернуть индекс первой строки ПОСЛЕ закрывающей скобки."""
    while i < len(lines):
        for ch in lines[i]:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
        i += 1
        if depth <= 0:
            break
    return i


def _read_md_block(lines: list[str], i: int, close_pipes: str) -> tuple[str, int]:
    """Тело `|md ... |`-блока: строки до закрывающих пайпов + пропуск опционального
    модификатора `{ near: ... }`. Возврат: (markdown, индекс строки после блока)."""
    buf: list[str] = []
    while i < len(lines):
        stripped = lines[i].lstrip()
        if stripped.startswith(close_pipes) and (
            stripped.rstrip() == close_pipes
            or re.match(rf"^\s*{re.escape(close_pipes)}\s*\{{", lines[i])
        ):
            break
        buf.append(lines[i])
        i += 1
    i += 1  # закрывающая линия пайпов
    if i < len(lines) and lines[i].lstrip().startswith("{"):
        i = _skip_braced_block(lines, i)
    return "\n".join(buf).strip(), i


def _apply_property(sh: D2Shape, key: str, val: str) -> None:
    """`shape:` / `style.fill:` / `style.stroke:` / `class: card` → поля шейпа."""
    if key == "shape":
        sh.kind = val
    elif key == "style.fill":
        sh.fill = val
    elif key == "style.stroke":
        sh.stroke = val
    elif key == "class" and val == "card":
        sh.kind = "card"


def _add_block_shape(
    shapes: dict[str, D2Shape], stack: list[str], name: str, raw_label: str | None
) -> None:
    """Открыватель `name {` / `name: "label" {` → шейп + push в stack."""
    full = ".".join([*stack, name])
    shapes.setdefault(
        full,
        D2Shape(kind="rectangle", label=_unescape(raw_label) if raw_label else name, fill=None),
    )
    stack.append(name)


def _add_leaf_shape(
    shapes: dict[str, D2Shape], stack: list[str], name: str, label: str, *, opens_block: bool
) -> None:
    """Лист `name: "label"` (возможно с `{`): создать шейп или обновить label."""
    full = ".".join([*stack, name])
    existing = shapes.get(full)
    if existing is None:
        shapes[full] = D2Shape(kind="rectangle", label=label, fill=None)
    else:
        existing.label = label
    if opens_block:
        stack.append(name)


def parse_d2_source(text: str) -> tuple[dict[str, D2Shape], list[Edge]]:
    """Парсит d2 текст. Возвращает {full_path: D2Shape}, [Edge].

    Поддерживает:
    - именованные шейпы с лейблом: `name: "label"` (с/без `{}`)
    - вложенные блоки `name { ... }`
    - properties `shape: cylinder`, `style.fill: "#xxx"`
    - связи `a -> b: "label"`
    - markdown-блоки `name: |md ... |`

    НЕ поддерживает: классы, импорты, vars, sql_table-таблицы — этим файлам не нужно.
    """
    shapes: dict[str, D2Shape] = {}
    edges: list[Edge] = []
    stack: list[str] = []
    lines = text.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        ls = lines[i].lstrip()
        if not ls or ls.startswith("#"):
            i += 1
            continue
        if ls.rstrip() == "}":
            if stack:
                stack.pop()
            i += 1
            continue
        for handler in _LINE_HANDLERS:
            nxt = handler(lines, i, ls, stack, shapes, edges)
            if nxt is not None:
                i = nxt
                break
        else:
            i += 1  # ни один хендлер не распознал строку — пропускаем
    return shapes, edges


# markdown block: `name: |md ... |` (любое число пайпов); закрывающая линия — те же N пайпов.
_MD_RE = re.compile(r"^([a-zA-Z_]\w*)\s*:\s*(\|+)md\s*$")
# connection: `a -> b` или `a -> b: "label"`.
_EDGE_RE = re.compile(r'^(\S[^:]*?)\s*->\s*(\S[^:]*?)(?:\s*:\s*"([^"]*)")?\s*$')
# property: shape / style.fill / style.stroke / class.
_PROP_RE = re.compile(r'^(shape|style\.fill|style\.stroke|class)\s*:\s*"?([^"\s{}]+)"?')
# block opener: `name {` / `name: {` / `name: "label" {`.
_OPEN_RE = re.compile(r'^([a-zA-Z_]\w*)\s*(?::\s*(?:"([^"]*)")?)?\s*\{\s*$')
# leaf with label: `name: "label"` или `name: "label" {`.
_LEAF_RE = re.compile(r'^([a-zA-Z_]\w*)\s*:\s*"([^"]*)"\s*(\{?)\s*$')


def _try_markdown(
    lines: list[str], i: int, ls: str, stack: list[str], shapes: dict[str, D2Shape], _e: list[Edge]
) -> int | None:
    m = _MD_RE.match(ls)
    if m is None:
        return None
    label, nxt = _read_md_block(lines, i + 1, m.group(2))
    shapes[".".join([*stack, m.group(1)])] = D2Shape(kind="markdown", label=label, fill=None)
    return nxt


def _try_connection(
    _lines: list[str], i: int, ls: str, _s: list[str], _sh: dict[str, D2Shape], edges: list[Edge]
) -> int | None:
    if "->" not in ls or re.match(r"^\s*(shape|style)", ls):
        return None
    m = _EDGE_RE.match(ls.rstrip())
    if m is None:
        return None
    edges.append(Edge(m.group(1).strip(), m.group(2).strip(), m.group(3) or ""))
    return i + 1


def _try_property(
    _lines: list[str], i: int, ls: str, stack: list[str], shapes: dict[str, D2Shape], _e: list[Edge]
) -> int | None:
    # `class: card` — sentinel: рендерим как Miro card (см. d2_miro.py). d2 валидирует имя класса
    # по объявленному `classes: {...}` блоку, поэтому тот блок должен быть в исходнике.
    m = _PROP_RE.match(ls)
    if m is None or not stack:
        return None
    owner = ".".join(stack)
    sh = shapes.setdefault(owner, D2Shape(kind="rectangle", label=stack[-1], fill=None))
    _apply_property(sh, m.group(1), m.group(2))
    return i + 1


def _try_block(
    lines: list[str], i: int, ls: str, stack: list[str], shapes: dict[str, D2Shape], _e: list[Edge]
) -> int | None:
    m = _OPEN_RE.match(ls)
    if m is None:
        return None
    name = m.group(1)
    # `style { ... }` — inline-стили шейпа, а не вложенный шейп: пропускаем содержимое, не пушим
    # stack. `classes { ... }` парсим как обычный nested-блок — каждый дочерний класс становится
    # шейпом `classes.<name>` со своими style.fill/stroke для дефолтов рендерера.
    if name == "style":
        return _skip_braced_block(lines, i + 1, depth=1)
    _add_block_shape(shapes, stack, name, m.group(2))
    return i + 1


def _try_leaf(
    _lines: list[str], i: int, ls: str, stack: list[str], shapes: dict[str, D2Shape], _e: list[Edge]
) -> int | None:
    m = _LEAF_RE.match(ls)
    if m is None:
        return None
    _add_leaf_shape(shapes, stack, m.group(1), _unescape(m.group(2)), opens_block=m.group(3) == "{")
    return i + 1


_LINE_HANDLERS = (_try_markdown, _try_connection, _try_property, _try_block, _try_leaf)


# ---------- SVG layout parser ----------


def _b64dec(s: str) -> str | None:
    pad = "=" * ((4 - len(s) % 4) % 4)
    try:
        return base64.b64decode(s + pad).decode("utf-8", "replace")
    except Exception:
        return None


_PATH_TOKEN_RE = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(-?\d+\.?\d*)")
# Сколько чисел потребляет каждая команда (per command iteration после первой пары для M).
_ARGS_PER_CMD: dict[str, int] = {
    "M": 2,
    "L": 2,
    "T": 2,
    "H": 1,
    "V": 1,
    "C": 6,
    "S": 4,
    "Q": 4,
    "A": 7,
}


def _coord(cur: float, value: float, *, relative: bool) -> float:
    """Абсолютная координата SVG-path: относительная команда — сдвиг от текущей."""
    return cur + value if relative else value


def _path_bbox(  # noqa: C901, PLR0912, PLR0915 — плоский dispatch по 8 SVG-командам
    d: str,
) -> tuple[float, float, float, float] | None:
    """Точный bbox SVG-path. Учитывает все команды + относительные варианты + H/V (1 число).

    Для C/S/Q включаем control-points в bbox — для d2-шейпов это даёт небольшой
    перезахват, но безопасно (никогда не меньше реального).
    """
    tokens = _PATH_TOKEN_RE.findall(d)
    if not tokens:
        return None
    xs: list[float] = []
    ys: list[float] = []
    cur_x = cur_y = 0.0
    start_x = start_y = 0.0
    cmd: str | None = None
    i = 0
    n = len(tokens)
    while i < n:
        cmd_tok, _num_tok = tokens[i]
        if cmd_tok:
            cmd = cmd_tok
            i += 1
            if cmd in ("Z", "z"):
                cur_x, cur_y = start_x, start_y
            continue
        if cmd is None:
            i += 1
            continue
        upper = cmd.upper()
        relative = cmd != upper
        args_n = _ARGS_PER_CMD.get(upper, 2)
        if i + args_n > n:
            break
        # collect args
        args = [float(tokens[i + k][1]) for k in range(args_n)]
        i += args_n

        if upper == "H":
            cur_x = _coord(cur_x, args[0], relative=relative)
            xs.append(cur_x)
            ys.append(cur_y)
        elif upper == "V":
            cur_y = _coord(cur_y, args[0], relative=relative)
            xs.append(cur_x)
            ys.append(cur_y)
        elif upper == "M":
            cur_x = _coord(cur_x, args[0], relative=relative)
            cur_y = _coord(cur_y, args[1], relative=relative)
            start_x, start_y = cur_x, cur_y
            xs.append(cur_x)
            ys.append(cur_y)
            cmd = "l" if relative else "L"
        elif upper in ("L", "T"):
            cur_x = _coord(cur_x, args[0], relative=relative)
            cur_y = _coord(cur_y, args[1], relative=relative)
            xs.append(cur_x)
            ys.append(cur_y)
        elif upper == "C":
            for k in (0, 2, 4):
                xs.append(_coord(cur_x, args[k], relative=relative))
                ys.append(_coord(cur_y, args[k + 1], relative=relative))
            cur_x = _coord(cur_x, args[4], relative=relative)
            cur_y = _coord(cur_y, args[5], relative=relative)
        elif upper in ("S", "Q"):
            for k in (0, 2):
                xs.append(_coord(cur_x, args[k], relative=relative))
                ys.append(_coord(cur_y, args[k + 1], relative=relative))
            cur_x = _coord(cur_x, args[2], relative=relative)
            cur_y = _coord(cur_y, args[3], relative=relative)
        elif upper == "A":
            cur_x = _coord(cur_x, args[5], relative=relative)
            cur_y = _coord(cur_y, args[6], relative=relative)
            xs.append(cur_x)
            ys.append(cur_y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _text_lines(text_el: ET.Element) -> str:
    parts: list[str] = []
    if text_el.text:
        parts.append(text_el.text)
    for t in text_el.iter(NS + "tspan"):
        if t.text:
            parts.append(t.text)
    return "\n".join(p for p in parts if p)


def parse_svg(  # noqa: PLR0915
    svg_text: str,
) -> tuple[dict[str, LayoutShape], list[Edge], tuple[float, float, float, float]]:
    """Парсит d2 SVG. Возвращает layout, edges, viewBox=(x, y, w, h).

    viewBox считаем из ВНУТРЕННЕГО <svg> (с margin'ом d2), там offset включён.
    """
    root = ET.fromstring(svg_text)
    inner_svg = root.find(NS + "svg")
    vb_str = (
        (inner_svg.get("viewBox") if inner_svg is not None else None)
        or root.get("viewBox")
        or "0 0 1000 1000"
    )
    vb_parts = vb_str.split()
    viewbox = (float(vb_parts[0]), float(vb_parts[1]), float(vb_parts[2]), float(vb_parts[3]))

    layout: dict[str, LayoutShape] = {}
    edges: list[Edge] = []
    for g in root.iter(NS + "g"):
        cls = g.get("class", "") or ""
        if not cls:
            continue
        # d2 пишет class="<base64> <classnames...>" когда у элемента указан `class:`
        # в исходнике. Берём первый токен (base64 от d2-path), остальные —
        # имена пользовательских классов, для нас не важны (kind мы тащим из d2-source).
        first_token = cls.split(" ", 1)[0]
        name = _b64dec(first_token)
        if name is None:
            continue
        # edge: name like `(src -&gt; dst)[N]` or `parent.(src -&gt; dst)[N]`
        if "-&gt;" in name or "->" in name:
            m = re.match(r"^(?:(.+)\.)?\(\s*(.+?)\s*-(?:&gt;|>)\s*(.+?)\s*\)(?:\[\d+\])?\s*$", name)
            if not m:
                continue
            prefix = m.group(1) or ""
            src, dst = m.group(2).strip(), m.group(3).strip()
            if prefix:
                # `loader.(default_export -> processJob)` -> `loader.default_export` etc.
                src = f"{prefix}.{src}"
                dst = f"{prefix}.{dst}"
            text_el = g.find(NS + "text")
            label = _text_lines(text_el) if text_el is not None else ""
            edges.append(Edge(src, dst, label))
            continue

        # shape: must contain inner <g class="shape">
        inner = next((sub for sub in g.findall(NS + "g") if sub.get("class", "") == "shape"), None)
        if inner is None:
            continue
        rect = inner.find(NS + "rect")
        fill: str | None = None
        if rect is not None:
            x = float(rect.get("x", "0"))
            y = float(rect.get("y", "0"))
            w = float(rect.get("width", "0"))
            h = float(rect.get("height", "0"))
            fill = rect.get("fill")
        else:
            paths = inner.findall(NS + "path")
            bbs = [bb for p in paths if (bb := _path_bbox(p.get("d", "") or ""))]
            if not bbs:
                continue
            x = min(b[0] for b in bbs)
            y = min(b[1] for b in bbs)
            x2 = max(b[2] for b in bbs)
            y2 = max(b[3] for b in bbs)
            w = x2 - x
            h = y2 - y
            fill = paths[0].get("fill") if paths else None

        text_el = g.find(NS + "text")
        label = _text_lines(text_el) if text_el is not None else ""
        layout[name] = LayoutShape(x=x, y=y, w=w, h=h, label=label, fill=fill)
    return layout, edges, viewbox


# ---------- mapping helpers ----------


# Маппинг d2 shape kinds → Miro REST API shape kinds.
# Miro v2 API поддерживает только узкий набор; cylinder там называется `can`,
# page/document близкого аналога нет — используем `flow_chart_predefined_process`
# (прямоугольник со скруглёнными вертикальными линиями), визуально близко к page.
D2_TO_MIRO_SHAPE: dict[str, str] = {
    "rectangle": "rectangle",
    "square": "rectangle",
    "page": "flow_chart_predefined_process",
    "document": "flow_chart_predefined_process",
    "cylinder": "can",
    "stored_data": "can",
    "cloud": "cloud",
    "hexagon": "hexagon",
    "circle": "circle",
    "oval": "circle",
    "diamond": "rhombus",
    "parallelogram": "parallelogram",
    "step": "rectangle",
    "package": "round_rectangle",
}


def to_miro_shape(d2_kind: str) -> str:
    return D2_TO_MIRO_SHAPE.get(d2_kind, "rectangle")


def container_names(shape_paths: list[str]) -> set[str]:
    """Именованные пути, у которых есть хотя бы один потомок (= это контейнер)."""
    out: set[str] = set()
    for p in shape_paths:
        parent = ".".join(p.split(".")[:-1])
        if parent:
            out.add(parent)
    return out


Color = Literal["fill", "stroke"]


def normalize_hex(c: str | None, fallback: str = "#ffffff") -> str:
    if not c:
        return fallback
    c = c.strip()
    if not c.startswith("#"):
        return fallback
    if len(c) in (4, 7):
        return c
    return fallback
