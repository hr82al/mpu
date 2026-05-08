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

    kind: str  # rectangle, cloud, cylinder, hexagon, page, markdown, ...
    label: str
    fill: str | None  # hex color from style.fill, если задан в исходнике


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
    while i < len(lines):
        ls = lines[i].lstrip()
        if not ls or ls.startswith("#"):
            i += 1
            continue
        if ls.rstrip() == "}":
            if stack:
                stack.pop()
            i += 1
            continue

        # markdown block: `name: |md ... |` или `|||md ... |||` (любое число пайпов).
        # Закрывающая линия — те же N пайпов плюс возможный модификатор `{ near: ... }`.
        m_md = re.match(r"^([a-zA-Z_]\w*)\s*:\s*(\|+)md\s*$", ls)
        if m_md:
            name = m_md.group(1)
            close_pipes = m_md.group(2)  # столько же пайпов — закрытие блока
            full = ".".join([*stack, name])
            buf: list[str] = []
            i += 1
            while i < len(lines):
                stripped = lines[i].lstrip()
                if stripped.startswith(close_pipes) and (
                    stripped.rstrip() == close_pipes
                    or re.match(rf"^\s*{re.escape(close_pipes)}\s*\{{", lines[i])
                ):
                    break
                buf.append(lines[i])
                i += 1
            shapes[full] = D2Shape(kind="markdown", label="\n".join(buf).strip(), fill=None)
            i += 1  # skip closing line
            # skip optional modifier block { ... }
            if i < len(lines) and lines[i].lstrip().startswith("{"):
                depth = 0
                while i < len(lines):
                    for ch in lines[i]:
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                    i += 1
                    if depth <= 0:
                        break
            continue

        # connection: `a -> b` или `a -> b: "label"` (исключаем `shape: ...` etc.)
        if "->" in ls and not re.match(r"^\s*(shape|style)", ls):
            m_e = re.match(
                r'^(\S[^:]*?)\s*->\s*(\S[^:]*?)(?:\s*:\s*"([^"]*)")?\s*$',
                ls.rstrip(),
            )
            if m_e:
                edges.append(Edge(m_e.group(1).strip(), m_e.group(2).strip(), m_e.group(3) or ""))
                i += 1
                continue

        # property: shape / style.fill / style.stroke
        m_prop = re.match(r'^(shape|style\.fill|style\.stroke)\s*:\s*"?([^"\s{}]+)"?', ls)
        if m_prop and stack:
            owner = ".".join(stack)
            sh = shapes.setdefault(owner, D2Shape(kind="rectangle", label=stack[-1], fill=None))
            key = m_prop.group(1)
            val = m_prop.group(2)
            if key == "shape":
                sh.kind = val
            elif key == "style.fill":
                sh.fill = val
            i += 1
            continue

        # block opener:
        #   `name {`           — без двоеточия
        #   `name: {`          — с двоеточием, без лейбла (например `style: {`)
        #   `name: "label" {`  — с лейблом
        m_open = re.match(r'^([a-zA-Z_]\w*)\s*(?::\s*(?:"([^"]*)")?)?\s*\{\s*$', ls)
        if m_open:
            name = m_open.group(1)
            # `style { ... }` — это inline-стили шейпа, а не вложенный шейп.
            # Пропускаем содержимое до парной закрывающей скобки, не пушим stack.
            if name == "style":
                depth = 1
                i += 1
                while i < len(lines) and depth > 0:
                    for ch in lines[i]:
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                    i += 1
                continue
            full = ".".join([*stack, name])
            shapes.setdefault(
                full, D2Shape(kind="rectangle", label=m_open.group(2) or name, fill=None)
            )
            stack.append(name)
            i += 1
            continue

        # leaf with label: `name: "label"` или `name: "label" {`
        m_leaf = re.match(r'^([a-zA-Z_]\w*)\s*:\s*"([^"]*)"\s*(\{?)\s*$', ls)
        if m_leaf:
            name, label, brace = m_leaf.group(1), m_leaf.group(2), m_leaf.group(3)
            full = ".".join([*stack, name])
            existing = shapes.get(full)
            if existing is None:
                shapes[full] = D2Shape(kind="rectangle", label=label, fill=None)
            else:
                existing.label = label
            if brace == "{":
                stack.append(name)
            i += 1
            continue

        i += 1
    return shapes, edges


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
    "M": 2, "L": 2, "T": 2,
    "H": 1, "V": 1,
    "C": 6, "S": 4, "Q": 4,
    "A": 7,
}


def _path_bbox(d: str) -> tuple[float, float, float, float] | None:
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
            x = cur_x + args[0] if relative else args[0]
            cur_x = x
            xs.append(x)
            ys.append(cur_y)
        elif upper == "V":
            y = cur_y + args[0] if relative else args[0]
            cur_y = y
            xs.append(cur_x)
            ys.append(y)
        elif upper == "M":
            x = cur_x + args[0] if relative else args[0]
            y = cur_y + args[1] if relative else args[1]
            cur_x, cur_y = x, y
            start_x, start_y = x, y
            xs.append(x)
            ys.append(y)
            cmd = "l" if relative else "L"
        elif upper in ("L", "T"):
            x = cur_x + args[0] if relative else args[0]
            y = cur_y + args[1] if relative else args[1]
            cur_x, cur_y = x, y
            xs.append(x)
            ys.append(y)
        elif upper == "C":
            for k in (0, 2, 4):
                px = cur_x + args[k] if relative else args[k]
                py = cur_y + args[k + 1] if relative else args[k + 1]
                xs.append(px)
                ys.append(py)
            cur_x = cur_x + args[4] if relative else args[4]
            cur_y = cur_y + args[5] if relative else args[5]
        elif upper in ("S", "Q"):
            for k in (0, 2):
                px = cur_x + args[k] if relative else args[k]
                py = cur_y + args[k + 1] if relative else args[k + 1]
                xs.append(px)
                ys.append(py)
            cur_x = cur_x + args[2] if relative else args[2]
            cur_y = cur_y + args[3] if relative else args[3]
        elif upper == "A":
            cur_x = cur_x + args[5] if relative else args[5]
            cur_y = cur_y + args[6] if relative else args[6]
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


def parse_svg(
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
        if not cls or " " in cls:
            continue
        name = _b64dec(cls)
        if name is None:
            continue
        # edge: name like `(src -&gt; dst)[N]` or `parent.(src -&gt; dst)[N]`
        if "-&gt;" in name or "->" in name:
            m = re.match(
                r"^(?:(.+)\.)?\(\s*(.+?)\s*-(?:&gt;|>)\s*(.+?)\s*\)(?:\[\d+\])?\s*$", name
            )
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
