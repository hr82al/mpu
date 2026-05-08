"""`mpu-d2-miro` — рендер d2-диаграммы в Miro как редактируемый фрейм.

Поведение:
- Берёт <file>.d2 (+ его SVG, при отсутствии вызывает локальный `d2`).
- Создаёт фрейм на доске Miro. Если фрейм с таким же title уже есть —
  он удаляется (со всем содержимым) и пересоздаётся. Идемпотентно.
- Позиция фрейма по умолчанию — справа от самого правого существующего фрейма.

ENV переменные (~/.config/mpu/.env):
    MIRO_TOKEN       — Personal Access Token
    MIRO_BOARD_ID    — ID доски (как в URL: ...board/<id>/)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import Annotated

import typer

from mpu.lib import env
from mpu.lib.d2_parser import (
    D2Shape,
    LayoutShape,
    container_names,
    normalize_hex,
    parse_d2_source,
    parse_svg,
    to_miro_shape,
)
from mpu.lib.miro import MiroClient

COMMAND_NAME = "mpu-d2-miro"

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


def _html(text: str) -> str:
    """HTML-escape + перевод \n -> <br/>. Miro принимает HTML в content/captions."""
    s = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.replace("\n", "<br/>")


def _html_inline(s: str) -> str:
    """Inline-формат строки для markdown-блока: escape + bold."""
    import re as _re

    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return _re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)


def _md_blocks(md: str) -> list[tuple[str, object]]:
    """Разбить markdown на последовательность блоков:
    ('text', html_str) — обычный текст (заголовки, абзацы, списки, **bold**)
    ('table', rows)   — таблица как list[list[str]], первый ряд — заголовок
                        (separator `|---|` уже отфильтрован).

    Каждый блок отрисуем в Miro отдельно: text → text-widget, table → сетка
    rectangle-шейпов (каждая ячейка editable).
    """
    import re as _re

    lines = md.split("\n")
    blocks: list[tuple[str, object]] = []
    cur_text: list[str] = []

    def flush_text() -> None:
        if not cur_text:
            return
        html = _text_lines_to_html("\n".join(cur_text))
        cur_text.clear()
        if html:
            blocks.append(("text", html))

    i = 0
    while i < len(lines):
        ls = lines[i].lstrip()
        if ls.startswith("|"):
            flush_text()
            rows: list[list[str]] = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                stripped = lines[i].strip().strip("|")
                cells = [c.strip() for c in stripped.split("|")]
                rows.append(cells)
                i += 1
            # удалить separator (вторая строка из ---/:: только)
            if len(rows) > 1 and all(
                _re.fullmatch(r"[-:\s]*", c) for c in rows[1]
            ):
                rows = [rows[0], *rows[2:]]
            if rows:
                blocks.append(("table", rows))
            continue
        cur_text.append(lines[i])
        i += 1
    flush_text()
    return blocks


def _text_lines_to_html(md: str) -> str:
    """Конвертирует не-табличный текст markdown в HTML (без обработки таблиц)."""
    import re as _re

    lines = md.split("\n")
    out: list[str] = []
    in_list = False
    for raw in lines:
        s = raw.rstrip()
        ls = s.lstrip()
        if not ls:
            if in_list:
                out.append("</ul>")
                in_list = False
            continue
        m_h = _re.match(r"^(#+)\s+(.+)$", ls)
        if m_h:
            if in_list:
                out.append("</ul>")
                in_list = False
            level = min(len(m_h.group(1)), 3)
            out.append(f"<h{level}>{_html_inline(m_h.group(2))}</h{level}>")
            continue
        m_li = _re.match(r"^\s*-\s+(.+)$", s)
        if m_li:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_html_inline(m_li.group(1))}</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        out.append(f"<p>{_html_inline(ls)}</p>")
    if in_list:
        out.append("</ul>")
    return "".join(out)


_TABLE_CHAR_W = 7.5  # средняя ширина символа при font 12px (Miro Open Sans)
_TABLE_LINE_H = 20.0
_TABLE_CELL_PAD_W = 16.0
_TABLE_CELL_PAD_H = 12.0
_TABLE_MIN_ROW_H = 40.0
_TABLE_MIN_COL_W = 80.0
_TABLE_PAD = 24.0


def _table_layout(
    rows: list[list[str]], total_width: float
) -> tuple[list[float], list[float]]:
    """Вычислить размеры колонок и строк таблицы для оптимального fit.

    Колонки: ширина по самой длинной строке в любой ячейке колонки. Если сумма
    превышает total_width — шкалируем пропорционально вниз; если меньше —
    шкалируем вверх до total_width (чтобы заполнить отведённое место).

    Строки: высота по максимальному числу wrapped-строк среди ячеек. Учитываем
    \\n в исходной ячейке плюс word-wrap по фактической ширине колонки.
    """
    if not rows:
        return [], []
    n_cols = max(len(r) for r in rows)
    if n_cols == 0:
        return [], []

    col_desired: list[float] = [_TABLE_MIN_COL_W] * n_cols
    for row in rows:
        for ci in range(min(len(row), n_cols)):
            cell = row[ci] or ""
            longest = max((len(line) for line in cell.split("\n")), default=0)
            need = longest * _TABLE_CHAR_W + _TABLE_CELL_PAD_W * 2
            if need > col_desired[ci]:
                col_desired[ci] = need

    s = sum(col_desired)
    if s <= 0:
        col_w = [_TABLE_MIN_COL_W] * n_cols
    elif s > total_width:
        # не влезаем — шкалируем вниз пропорционально
        col_w = [w * total_width / s for w in col_desired]
    else:
        # помещается — оставляем точно по содержимому, без растягивания на весь блок
        col_w = list(col_desired)

    row_h: list[float] = []
    for row in rows:
        max_lines = 1
        for ci in range(min(len(row), n_cols)):
            cell = row[ci] or ""
            inner_w = col_w[ci] - _TABLE_CELL_PAD_W * 2
            chars_per_line = max(1, int(inner_w / _TABLE_CHAR_W))
            lines_in_cell = 0
            for raw in cell.split("\n"):
                # ceil(len/chars_per_line) с минимумом 1
                lines_in_cell += max(1, -(-len(raw) // chars_per_line)) if raw else 1
            if lines_in_cell > max_lines:
                max_lines = lines_in_cell
        row_h.append(max(_TABLE_MIN_ROW_H, max_lines * _TABLE_LINE_H + _TABLE_CELL_PAD_H * 2))
    return col_w, row_h


def _render_markdown(
    client,  # type: ignore[no-untyped-def]
    *,
    frame_id: str,
    blocks: list[tuple[str, object]],
    x_center: float,
    y_top: float,
    width: float,
) -> float:
    """Рисует markdown-блоки в Miro: text-блоки как text widget, таблицы как
    сетку rectangle-шейпов. Возвращает финальный y_top после всех блоков.

    Если за text-блоком следует таблица — сжимаем зазор и не насчитываем
    минимум-высоту (текст работает как заголовок таблицы, должен прижиматься к ней).
    """
    cur_y = y_top
    text_line_h = 24.0
    text_block_pad = 24.0
    text_to_table_pad = 6.0  # короткий зазор между заголовком и таблицей под ним
    for idx, (kind, content) in enumerate(blocks):
        next_block = blocks[idx + 1] if idx + 1 < len(blocks) else None
        next_is_table = next_block is not None and next_block[0] == "table"
        if kind == "text":
            html = content if isinstance(content, str) else ""
            visible_lines = (
                html.count("<br") + html.count("<p>") + html.count("<li>") + html.count("<h")
            ) or 1
            # Если за текстом идёт таблица — выравниваем ширину текста под таблицу,
            # чтобы заголовок встал ровно над ней (а не растянулся на весь md-блок).
            text_width = width
            if next_is_table:
                next_rows = next_block[1] if isinstance(next_block[1], list) else []
                if next_rows:
                    next_col_w, _ = _table_layout(next_rows, width)
                    if next_col_w:
                        text_width = sum(next_col_w)
                block_h = visible_lines * text_line_h + 12.0
                pad = text_to_table_pad
            else:
                block_h = max(80.0, visible_lines * text_line_h + 16.0)
                pad = text_block_pad
            try:
                client.create_text(
                    parent_id=frame_id,
                    content_html=html,
                    x=x_center,
                    y=cur_y + block_h / 2,
                    width=text_width,
                )
            except Exception as e:
                print(f"[skip] md text: {e}", file=sys.stderr)
            cur_y += block_h + pad
            continue
        if kind == "table":
            rows = content if isinstance(content, list) else []
            if not rows:
                continue
            col_w, row_h = _table_layout(rows, width)
            n_cols = len(col_w)
            x_left = x_center - sum(col_w) / 2
            row_top = cur_y
            for ri, row in enumerate(rows):
                is_header = ri == 0
                cy = row_top + row_h[ri] / 2
                cell_x = x_left
                for ci in range(n_cols):
                    cell = row[ci] if ci < len(row) else ""
                    cx = cell_x + col_w[ci] / 2
                    try:
                        client.create_shape(
                            parent_id=frame_id,
                            kind="rectangle",
                            content_html=f"<p>{_html_inline(cell)}</p>",
                            x=cx, y=cy,
                            width=col_w[ci], height=row_h[ri],
                            fill="#e8eaf6" if is_header else "#ffffff",
                            border_width="1",
                            border_color="#9e9e9e",
                            font_size="13" if is_header else "12",
                        )
                    except Exception as e:
                        print(f"[skip] md table cell: {e}", file=sys.stderr)
                    cell_x += col_w[ci]
                row_top += row_h[ri]
            cur_y = row_top + _TABLE_PAD
            continue
    return cur_y


def _estimate_md_height(blocks: list[tuple[str, object]], width: float) -> float:
    """Оценить высоту markdown-блока в Miro. Симметрично с _render_markdown,
    включая компактную упаковку «заголовок + таблица»."""
    text_line_h = 24.0
    text_block_pad = 24.0
    text_to_table_pad = 6.0
    h = 0.0
    for idx, (kind, content) in enumerate(blocks):
        next_is_table = idx + 1 < len(blocks) and blocks[idx + 1][0] == "table"
        if kind == "text":
            html = content if isinstance(content, str) else ""
            visible_lines = (
                html.count("<br") + html.count("<p>") + html.count("<li>") + html.count("<h")
            ) or 1
            if next_is_table:
                h += visible_lines * text_line_h + 12.0 + text_to_table_pad
            else:
                h += max(80.0, visible_lines * text_line_h + 16.0) + text_block_pad
        elif kind == "table":
            rows = content if isinstance(content, list) else []
            if rows:
                _, row_h = _table_layout(rows, width)
                h += sum(row_h) + _TABLE_PAD
    return h


def _md_to_html(md: str) -> str:
    """Backward-compat wrapper: только не-табличная часть markdown -> HTML.
    Для полного рендера (с таблицами) используйте _md_blocks + _render_markdown."""
    return _text_lines_to_html(md)


def _ensure_svg(d2_path: Path, skip_render: bool) -> Path:
    """Вернуть путь к рендеру d2. Если SVG нет — вызвать `d2` CLI."""
    svg = d2_path.with_suffix(".svg")
    if skip_render and svg.exists():
        return svg
    if svg.exists() and svg.stat().st_mtime >= d2_path.stat().st_mtime:
        return svg
    if shutil.which("d2") is None:
        if svg.exists():
            typer.echo(
                f"[warn] d2 CLI not found, using stale {svg} (file mtime older than .d2)",
                err=True,
            )
            return svg
        raise RuntimeError(
            "d2 CLI is not in PATH and no SVG file exists next to the .d2 source. "
            "Install d2 (https://d2lang.com) or pass --skip-render with a pre-rendered .svg."
        )
    typer.echo(f"[info] rendering {d2_path.name} -> {svg.name}", err=True)
    subprocess.run(["d2", str(d2_path), str(svg)], check=True)
    return svg


def _parse_position(s: str | None) -> tuple[float, float] | None:
    if not s:
        return None
    try:
        a, b = s.split(",", 1)
        return float(a.strip()), float(b.strip())
    except ValueError as e:
        raise typer.BadParameter(f"--position must be 'x,y', got {s!r}") from e


def _build_frame_size(viewbox_w: float, viewbox_h: float) -> tuple[float, float, float]:
    """Размер фрейма на доске = размер d2 viewBox (scale 1:1).

    d2 рассчитывает размер каждого шейпа под его текст и шрифт. Уменьшение
    приведёт к обрезанию подписей, поэтому масштаб всегда 1:1.
    """
    return viewbox_w, viewbox_h, 1.0


def _to_miro_xy(
    sx: float, sy: float, sw: float, sh: float,
    vb_x: float, vb_y: float, vb_w: float, vb_h: float,
    frame_w: float, frame_h: float,
    scale: float,
) -> tuple[float, float, float, float]:
    """SVG top-left -> Miro shape center в системе координат «от top-left фрейма».

    Для items с parent Miro REST API ожидает position в parent-локальных
    координатах, где (0,0) — это top-left угол фрейма, а position указывает
    центр shape (origin=center по умолчанию).
    """
    cx_svg = sx + sw / 2
    cy_svg = sy + sh / 2
    nx = (cx_svg - vb_x) / vb_w
    ny = (cy_svg - vb_y) / vb_h
    mx = nx * frame_w
    my = ny * frame_h
    return mx, my, sw * scale, sh * scale


@app.command()
def main(
    d2_file: Annotated[
        Path,
        typer.Argument(exists=True, dir_okay=False, readable=True, help=".d2 source file"),
    ],
    title: Annotated[
        str | None,
        typer.Option("--title", help="Frame title on board (default: filename without ext)"),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option("--board", help="Override MIRO_BOARD_ID for this run"),
    ] = None,
    position: Annotated[
        str | None,
        typer.Option(
            "--position",
            help="Frame center coords as 'x,y'. Default: auto (right of rightmost frame)",
        ),
    ] = None,
    skip_render: Annotated[
        bool,
        typer.Option("--skip-render", help="Use existing .svg without re-running d2"),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Parse and report plan; do not call Miro API"),
    ] = False,
) -> None:
    """Render a d2 diagram into a Miro board frame."""
    token = env.require("MIRO_TOKEN")
    board_id = board or env.require("MIRO_BOARD_ID")
    frame_title = title or d2_file.stem

    svg_path = _ensure_svg(d2_file, skip_render=skip_render)
    d2_text = d2_file.read_text(encoding="utf-8")
    svg_text = svg_path.read_text(encoding="utf-8")

    d2_shapes, _d2_edges = parse_d2_source(d2_text)
    layout, edges, viewbox = parse_svg(svg_text)
    vb_x, vb_y, vb_w, vb_h = viewbox

    only_in_layout = sorted(set(layout) - set(d2_shapes))
    only_in_d2 = sorted(set(d2_shapes) - set(layout))
    if only_in_layout:
        typer.echo(f"[warn] in SVG but not in d2 source: {only_in_layout}", err=True)
    if only_in_d2:
        typer.echo(f"[warn] in d2 source but not in SVG: {only_in_d2}", err=True)

    frame_w, frame_h_diagram, scale = _build_frame_size(vb_w, vb_h)

    # Под markdown-блоки (annotation/summary) расширяем высоту фрейма.
    # Высоту считаем точно по структуре блоков — таблица занимает row_count * row_h,
    # text-блок ~ visible_lines * line_h.
    md_only_in_d2 = [
        n for n, sh in d2_shapes.items() if sh.kind == "markdown" and n not in layout
    ]
    md_padding = 80.0
    md_blocks_per_name: dict[str, list[tuple[str, object]]] = {
        n: _md_blocks(d2_shapes[n].label) for n in md_only_in_d2
    }
    # Ширина markdown-области = 90% фрейма (та же, что в рендере) — нужна для
    # расчёта word-wrap в таблицах.
    md_block_w = max(frame_w * 0.9, 600.0)
    md_block_heights: dict[str, float] = {
        n: _estimate_md_height(md_blocks_per_name[n], md_block_w) for n in md_only_in_d2
    }
    md_total_h = sum(md_block_heights.values()) + md_padding * (len(md_only_in_d2) + 1)
    frame_h = frame_h_diagram + md_total_h

    typer.echo(
        f"[info] {d2_file.name}: {len(layout)} shapes, {len(edges)} edges, "
        f"{len(md_only_in_d2)} markdown blocks; "
        f"viewBox {vb_w:.0f}x{vb_h:.0f} -> frame {frame_w:.0f}x{frame_h:.0f} "
        f"(scale={scale:.3f})",
        err=True,
    )

    if dry_run:
        typer.echo("[dry-run] would create:")
        for name in sorted(layout):
            d2info = d2_shapes.get(name)
            kind = d2info.kind if d2info else "rectangle"
            target = "card" if kind == "card" else f"shape({to_miro_shape(kind)})"
            typer.echo(f"  {target:20} {name}  kind={kind}")
        for e in edges:
            src_kind = (d2_shapes.get(e.src) or D2Shape("rectangle", "", None)).kind
            dst_kind = (d2_shapes.get(e.dst) or D2Shape("rectangle", "", None)).kind
            note = " [skipped: card→card]" if src_kind == "card" and dst_kind == "card" else ""
            typer.echo(f"  edge   {e.src} -> {e.dst}  label={e.label[:30]!r}{note}")
        return

    client = MiroClient(token, board_id)

    # 1. Если фрейм с таким title уже есть — берём его позицию (idempotent: при
    # повторном рендере фрейм не «переезжает», даже если пользователь сам его
    # подвинул на доске). Только потом удаляем старый.
    existing = client.find_frame_by_title(frame_title)
    pos = _parse_position(position)
    if pos is None:
        if existing is not None:
            pos = (existing.x, existing.y)
        else:
            # Кладём справа от самого правого *оставшегося* фрейма + зазор.
            right_x, avg_y = client.rightmost_frame_edge()
            pos = (right_x + 200 + frame_w / 2, avg_y)
    if existing is not None:
        typer.echo(f"[info] removing existing frame {frame_title!r} ({existing.id})", err=True)
        client.delete_frame(existing.id)
    frame = client.create_frame(
        title=frame_title, x=pos[0], y=pos[1], width=frame_w, height=frame_h
    )
    typer.echo(f"[info] created frame {frame.id} at ({pos[0]:.0f}, {pos[1]:.0f})", err=True)

    # 3. shapes (containers first for proper z-order)
    containers = container_names(list(layout.keys()))
    ordered = sorted(layout.keys(), key=lambda n: (n not in containers, n))
    name_to_id: dict[str, str] = {}

    # L-indent для card-колонок: контейнер с ребёнком `header` (class=card) +
    # другими card-детьми → подзадачи смещаем вправо относительно header.
    # Header остаётся на левой границе колонки, подзадачи отступают на CARD_INDENT.
    CARD_INDENT = 60.0
    for cont in containers:
        depth = cont.count(".") + 1
        direct = [
            n for n in layout
            if n != cont and n.startswith(cont + ".") and n.count(".") == depth
        ]
        cards = [
            n for n in direct
            if (s := d2_shapes.get(n)) is not None and s.kind == "card"
        ]
        header_name = f"{cont}.header"
        if header_name not in cards or len(cards) < 2:
            continue
        for st in cards:
            if st == header_name:
                continue
            layout[st].x += CARD_INDENT
        # пересчитать bbox контейнера, чтобы он покрыл смещённые подзадачи
        x1 = min(layout[c].x for c in direct)
        y1 = min(layout[c].y for c in direct)
        x2 = max(layout[c].x + layout[c].w for c in direct)
        y2 = max(layout[c].y + layout[c].h for c in direct)
        layout[cont].x = x1
        layout[cont].y = y1
        layout[cont].w = x2 - x1
        layout[cont].h = y2 - y1

    # Размер контейнера считаем заново: bbox прямых детей + щедрый padding +
    # дополнительная подушка сверху под заголовок контейнера. Так дети
    # гарантированно не пересекают границу группы при любом рендере.
    container_pad = 50.0
    container_title_pad = 80.0

    container_bboxes: dict[str, tuple[float, float, float, float]] = {}
    for cont in containers:
        depth = cont.count(".") + 1
        direct = [
            n for n in layout
            if n != cont and n.startswith(cont + ".") and n.count(".") == depth
        ]
        if not direct:
            continue
        x1 = min(layout[c].x for c in direct)
        y1 = min(layout[c].y for c in direct)
        x2 = max(layout[c].x + layout[c].w for c in direct)
        y2 = max(layout[c].y + layout[c].h for c in direct)
        container_bboxes[cont] = (x1, y1, x2 - x1, y2 - y1)

    for name in ordered:
        shape: LayoutShape = layout[name]
        d2info = d2_shapes.get(name)
        kind = d2info.kind if d2info else "rectangle"
        is_container = name in containers
        if is_container and name in container_bboxes:
            bx, by, bw, bh = container_bboxes[name]
            sx = bx - container_pad
            sy = by - container_pad - container_title_pad
            sw = bw + container_pad * 2
            sh = bh + container_pad * 2 + container_title_pad
        else:
            sx, sy, sw, sh = shape.x, shape.y, shape.w, shape.h
        mx, my, mw, mh = _to_miro_xy(
            sx, sy, sw, sh, vb_x, vb_y, vb_w, vb_h, frame_w, frame_h, scale,
        )

        if kind == "markdown":
            md_text = (d2info.label if d2info else shape.label) or shape.label
            try:
                tid = client.create_text(
                    parent_id=frame.id,
                    content_html=f"<p>{_html(md_text)}</p>",
                    x=mx, y=my,
                    width=max(mw, 360),
                )
                name_to_id[name] = tid
            except Exception as e:
                typer.echo(f"[skip] markdown {name}: {e}", err=True)
            continue

        if kind == "card":
            # Card: рендерим как round_rectangle shape, не как Miro card-item.
            # Причина: у Miro card нет отдельного border-color (style.cardTheme —
            # это лишь цветная полоска), а пользователь хочет жёлтую рамку вокруг
            # всего элемента. round_rectangle визуально похож на card и даёт
            # полный контроль над border'ом.
            raw = (d2info.label if d2info else shape.label) or shape.label or name.split(".")[-1]
            class_default = d2_shapes.get("classes.card")
            border_color = normalize_hex(
                (d2info.stroke if d2info else None)
                or (class_default.stroke if class_default else None),
                "#ffd54f",
            )
            fill = normalize_hex(
                shape.fill
                or (d2info.fill if d2info else None)
                or (class_default.fill if class_default else None),
                "#ffffff",
            )
            try:
                sid = client.create_shape(
                    parent_id=frame.id,
                    kind="round_rectangle",
                    content_html=f"<p>{_html(raw)}</p>",
                    x=mx, y=my, width=mw, height=mh,
                    fill=fill,
                    border_color=border_color,
                    border_width="3",
                    font_size="12",
                    text_align="left",
                    text_align_vertical="top",
                )
                name_to_id[name] = sid
            except Exception as e:
                typer.echo(f"[skip] card {name}: {e}", err=True)
            continue

        fill = normalize_hex(shape.fill or (d2info.fill if d2info else None), "#ffffff")
        # Прозрачный/none stroke в d2 → border_width=0 (контейнер-обёртка без видимого outline).
        stroke_raw = (d2info.stroke if d2info else None)
        invisible_border = stroke_raw in ("transparent", "none")
        if invisible_border:
            border_width = "0"
            border_color = "#ffffff"
        else:
            border_width = "2" if is_container else "1"
            border_color = normalize_hex(stroke_raw, "#1a1a1a")

        try:
            sid = client.create_shape(
                parent_id=frame.id,
                kind=to_miro_shape(kind),
                content_html=f"<p>{_html(shape.label or name.split('.')[-1])}</p>",
                x=mx, y=my, width=mw, height=mh,
                fill=fill,
                fill_opacity="0.5" if is_container else "1.0",
                border_color=border_color,
                border_width=border_width,
                border_style="dashed" if (is_container and not invisible_border) else "normal",
                font_size="18" if is_container else "12",
                # Заголовок контейнера прижимаем к верху (по умолчанию middle), чтобы
                # содержимое внутри читалось без перекрытия с названием группы.
                text_align="left" if is_container else "center",
                text_align_vertical="top" if is_container else "middle",
            )
            name_to_id[name] = sid
        except Exception as e:
            typer.echo(f"[skip] shape {name}: {e}", err=True)

    # 3b. markdown-блоки, которых нет в SVG layout (footnotes/summary внизу).
    # d2 не выкладывает их с base64-class в SVG. Рендерим: text-части как text widget,
    # таблицы — как сетку rectangle-шейпов (каждая ячейка editable отдельно).
    if md_only_in_d2:
        cur_y = frame_h_diagram + md_padding
        x_center = frame_w / 2
        for name in md_only_in_d2:
            blocks = md_blocks_per_name[name]
            try:
                end_y = _render_markdown(
                    client,
                    frame_id=frame.id,
                    blocks=blocks,
                    x_center=x_center,
                    y_top=cur_y,
                    width=md_block_w,
                )
                cur_y = end_y + md_padding
            except Exception as e:
                typer.echo(f"[skip] markdown {name}: {e}", err=True)
                cur_y += md_block_heights[name] + md_padding

    # 4. connectors. Для bidirectional пар (A→B и B→A) разводим по разным
    # сторонам шейпов: «алфавитно меньшая» вершина edge — снизу, обратная — сверху.
    edge_set = {(e.src, e.dst) for e in edges}
    created_edges = 0
    for e in edges:
        src_id = name_to_id.get(e.src)
        dst_id = name_to_id.get(e.dst)
        if not src_id or not dst_id:
            missing = [n for n in (e.src, e.dst) if n not in name_to_id]
            typer.echo(f"[skip] edge {e.src} -> {e.dst} (no shape: {missing})", err=True)
            continue
        snap_start: str | None = None
        snap_end: str | None = None
        if (e.dst, e.src) in edge_set:
            # bidirectional pair: deterministic split — forward use top, backward use bottom
            if e.src < e.dst:
                snap_start = snap_end = "top"
            else:
                snap_start = snap_end = "bottom"
        try:
            label_html = (
                f'<span style="font-size:10px">{_html(e.label)}</span>' if e.label else ""
            )
            client.create_connector(
                src_id=src_id,
                dst_id=dst_id,
                label=label_html,
                shape="curved",
                snap_start=snap_start,
                snap_end=snap_end,
            )
            created_edges += 1
        except Exception as exc:
            typer.echo(f"[skip] connector {e.src} -> {e.dst}: {exc}", err=True)

    typer.echo(
        f"[done] frame={frame_title!r} shapes={len(name_to_id)} connectors={created_edges}",
        err=True,
    )


def run() -> None:
    """Entry point для `mpu-d2-miro`."""
    app()


if __name__ == "__main__":
    sys.exit(run())
