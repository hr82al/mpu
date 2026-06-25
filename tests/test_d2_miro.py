"""Тесты `mpu/commands/d2_miro.py` — рендер d2-диаграммы в Miro.

Покрываем три уровня:
- чистые helper'ы рендера markdown/таблиц (`_html`, `_md_blocks`, `_table_layout`, …) —
  юнит-тестами напрямую;
- `_ensure_svg` (наличие/отсутствие `d2` CLI, перерисовка, stale-svg) с замоканными
  `shutil.which` / `subprocess.run`;
- CLI-flow `main` через `CliRunner` с фейковым `MiroClient` (проверяем payload вызовов
  create_*), замоканными парсерами d2/SVG и `env.require`.

Внешних обращений (Miro REST, файлы вне tmp, d2 CLI) нет — всё на швах.
"""
# pyright: reportPrivateUsage=false
# Тестируем underscore-helper'ы модуля (_html/_md_blocks/_ensure_svg/…) и подменяем
# приватные атрибуты фейкового клиента — отсюда file-level reportPrivateUsage=false.

import os
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import d2_miro
from mpu.lib.d2_parser import D2Shape, Edge, LayoutShape
from mpu.lib.miro import FrameRef, MiroClient

runner = CliRunner()


# ── фейковый Miro-клиент: подкласс MiroClient (тип-совместим для _render_markdown) ──


@dataclass
class _FrameCall:
    title: str
    x: float
    y: float
    width: float
    height: float


@dataclass
class _TextCall:
    parent_id: str
    content_html: str
    x: float
    y: float
    width: float


@dataclass
class _ShapeCall:
    parent_id: str
    kind: str
    content_html: str
    x: float
    y: float
    width: float
    height: float
    fill: str
    fill_opacity: str
    border_color: str
    border_width: str
    border_style: str
    font_size: str
    text_align: str
    text_align_vertical: str


@dataclass
class _ConnectorCall:
    src_id: str
    dst_id: str
    label: str
    shape: str
    snap_start: str | None
    snap_end: str | None


@dataclass
class _Rec:
    """Журнал вызовов фейкового MiroClient + управление поведением."""

    frames: list[_FrameCall] = field(default_factory=list[_FrameCall])
    texts: list[_TextCall] = field(default_factory=list[_TextCall])
    shapes: list[_ShapeCall] = field(default_factory=list[_ShapeCall])
    connectors: list[_ConnectorCall] = field(default_factory=list[_ConnectorCall])
    deleted: list[str] = field(default_factory=list[str])
    init_args: tuple[str, str] | None = None
    existing_frame: FrameRef | None = None
    rightmost: tuple[float, float] = (0.0, 0.0)
    raise_text: bool = False
    raise_shape: bool = False
    raise_connector: bool = False
    frame_seq: int = 0
    shape_seq: int = 0
    text_seq: int = 0
    conn_seq: int = 0


class _FakeMiroClient(MiroClient):
    """Не ходит в сеть: пишет каждый create_* в `_Rec`. Сигнатуры методов копируют
    реальные (pyright override-compat). __init__ намеренно не зовёт super()."""

    def __init__(self, rec: _Rec, token: str, board_id: str) -> None:
        self._rec = rec
        rec.init_args = (token, board_id)

    def find_frame_by_title(self, title: str) -> FrameRef | None:
        ef = self._rec.existing_frame
        if ef is not None and ef.title == title:
            return ef
        return None

    def rightmost_frame_edge(self) -> tuple[float, float]:
        return self._rec.rightmost

    def delete_frame(self, frame_id: str) -> None:
        self._rec.deleted.append(frame_id)

    def create_frame(
        self, *, title: str, x: float, y: float, width: float, height: float
    ) -> FrameRef:
        self._rec.frame_seq += 1
        self._rec.frames.append(_FrameCall(title, x, y, width, height))
        return FrameRef(id=f"frame-{self._rec.frame_seq}", title=title, x=x, y=y, w=width, h=height)

    def create_text(
        self, *, parent_id: str, content_html: str, x: float, y: float, width: float
    ) -> str:
        if self._rec.raise_text:
            raise RuntimeError("boom-text")
        self._rec.text_seq += 1
        self._rec.texts.append(_TextCall(parent_id, content_html, x, y, width))
        return f"text-{self._rec.text_seq}"

    def create_shape(
        self,
        *,
        parent_id: str,
        kind: str,
        content_html: str,
        x: float,
        y: float,
        width: float,
        height: float,
        fill: str = "#ffffff",
        fill_opacity: str = "1.0",
        border_color: str = "#1a1a1a",
        border_width: str = "1",
        border_style: str = "normal",
        font_size: str = "12",
        text_align: str = "center",
        text_align_vertical: str = "middle",
    ) -> str:
        if self._rec.raise_shape:
            raise RuntimeError("boom-shape")
        self._rec.shape_seq += 1
        self._rec.shapes.append(
            _ShapeCall(
                parent_id,
                kind,
                content_html,
                x,
                y,
                width,
                height,
                fill,
                fill_opacity,
                border_color,
                border_width,
                border_style,
                font_size,
                text_align,
                text_align_vertical,
            )
        )
        return f"shape-{self._rec.shape_seq}"

    def create_connector(
        self,
        *,
        src_id: str,
        dst_id: str,
        label: str = "",
        shape: str = "elbowed",
        snap_start: str | None = None,
        snap_end: str | None = None,
    ) -> str:
        if self._rec.raise_connector:
            raise RuntimeError("boom-conn")
        self._rec.conn_seq += 1
        self._rec.connectors.append(
            _ConnectorCall(src_id, dst_id, label, shape, snap_start, snap_end)
        )
        return f"conn-{self._rec.conn_seq}"


# ── helpers для CLI-flow тестов ──────────────────────────────────────────────


def _d2(kind: str, label: str, fill: str | None = None, stroke: str | None = None) -> D2Shape:
    return D2Shape(kind=kind, label=label, fill=fill, stroke=stroke)


def _layout(
    x: float, y: float, w: float, h: float, label: str = "", fill: str | None = None
) -> LayoutShape:
    return LayoutShape(x=x, y=y, w=w, h=h, label=label, fill=fill)


def _write_pair(tmp: Path, *, with_svg: bool = True, stem: str = "diagram") -> Path:
    """Создать `<stem>.d2` (+ свежий `.svg`) в tmp. Возвращает путь к .d2."""
    d2 = tmp / f"{stem}.d2"
    d2.write_text('x: "X"\n', encoding="utf-8")
    if with_svg:
        svg = tmp / f"{stem}.svg"
        svg.write_text("<svg></svg>", encoding="utf-8")
        st = d2.stat()
        os.utime(svg, (st.st_atime + 10, st.st_mtime + 10))
    return d2


def _which_none(_name: str) -> str | None:
    return None


def _which_found(_name: str) -> str | None:
    return "/usr/bin/d2"


def _patch_env(
    monkeypatch: pytest.MonkeyPatch, *, token: str | None = "tok", board: str | None = "board"
) -> None:
    def _require(name: str) -> str:
        if name == "MIRO_TOKEN":
            if token is None:
                raise RuntimeError("environment variable MIRO_TOKEN is not set")
            return token
        if name == "MIRO_BOARD_ID":
            if board is None:
                raise RuntimeError("environment variable MIRO_BOARD_ID is not set")
            return board
        raise RuntimeError(f"unexpected env var {name}")

    monkeypatch.setattr(d2_miro.env, "require", _require)


def _patch_pipeline(
    monkeypatch: pytest.MonkeyPatch,
    *,
    d2_shapes: dict[str, D2Shape],
    layout: dict[str, LayoutShape],
    svg_edges: list[Edge],
    d2_edges: list[Edge] | None = None,
    viewbox: tuple[float, float, float, float] = (0.0, 0.0, 200.0, 100.0),
) -> None:
    """Подменить парсеры d2/SVG, чтобы main работал на контролируемых данных."""
    edges_src = d2_edges if d2_edges is not None else svg_edges

    def _fake_d2(text: str) -> tuple[dict[str, D2Shape], list[Edge]]:
        _ = text
        return d2_shapes, edges_src

    def _fake_svg(
        text: str,
    ) -> tuple[dict[str, LayoutShape], list[Edge], tuple[float, float, float, float]]:
        _ = text
        return layout, svg_edges, viewbox

    monkeypatch.setattr(d2_miro, "parse_d2_source", _fake_d2)
    monkeypatch.setattr(d2_miro, "parse_svg", _fake_svg)


def _install_client(monkeypatch: pytest.MonkeyPatch, rec: _Rec) -> None:
    def _factory(token: str, board_id: str) -> _FakeMiroClient:
        return _FakeMiroClient(rec, token, board_id)

    monkeypatch.setattr(d2_miro, "MiroClient", _factory)


# ============================================================================
# Чистые helper'ы: HTML
# ============================================================================


def test_html_escapes_and_newline_to_br() -> None:
    assert d2_miro._html("a<b>&\n c") == "a&lt;b&gt;&amp;<br/> c"


def test_html_inline_bold_and_escape() -> None:
    assert d2_miro._html_inline("x < y & **z**") == "x &lt; y &amp; <strong>z</strong>"


# ============================================================================
# _md_blocks / _text_lines_to_html
# ============================================================================


def test_md_blocks_text_and_table() -> None:
    md = "# Heading\nSome text\n\n| Col1 | Col2 |\n|------|------|\n| a | b |"
    blocks = d2_miro._md_blocks(md)
    assert blocks[0][0] == "text"
    assert isinstance(blocks[0][1], str)
    assert "<h1>Heading</h1>" in blocks[0][1]
    assert "<p>Some text</p>" in blocks[0][1]
    assert blocks[1] == ("table", [["Col1", "Col2"], ["a", "b"]])


def test_md_blocks_table_without_separator_kept_whole() -> None:
    # Однострочная "таблица" без separator-строки — не фильтруется.
    blocks = d2_miro._md_blocks("| only | row |")
    assert blocks == [("table", [["only", "row"]])]


def test_md_blocks_empty() -> None:
    assert d2_miro._md_blocks("") == []


def test_text_lines_to_html_headers_list_paragraph() -> None:
    html = d2_miro._text_lines_to_html("## Sub\n- item **x**\n\npara")
    assert html == "<h2>Sub</h2><ul><li>item <strong>x</strong></li></ul><p>para</p>"


def test_text_lines_to_html_header_level_clamped_to_3() -> None:
    assert d2_miro._text_lines_to_html("#### Deep") == "<h3>Deep</h3>"


def test_text_lines_to_html_list_at_end_closes_ul() -> None:
    assert d2_miro._text_lines_to_html("- only") == "<ul><li>only</li></ul>"


def test_text_lines_to_html_empty() -> None:
    assert d2_miro._text_lines_to_html("") == ""


def test_text_lines_to_html_header_closes_open_list() -> None:
    # `- a` → список; `- b` — второй пункт без нового <ul>; `# H` — закрывает список.
    html = d2_miro._text_lines_to_html("- a\n- b\n# H")
    assert html == "<ul><li>a</li><li>b</li></ul><h1>H</h1>"


def test_text_lines_to_html_paragraph_closes_open_list() -> None:
    assert d2_miro._text_lines_to_html("- a\npara") == "<ul><li>a</li></ul><p>para</p>"


# ============================================================================
# _table_layout
# ============================================================================


def test_table_layout_empty_rows() -> None:
    assert d2_miro._table_layout([], 100.0) == ([], [])


def test_table_layout_no_columns() -> None:
    assert d2_miro._table_layout([[]], 100.0) == ([], [])


def test_table_layout_scales_down_when_too_wide() -> None:
    col_w, row_h = d2_miro._table_layout([["A" * 200]], 100.0)
    assert len(col_w) == 1
    assert abs(col_w[0] - 100.0) < 1e-6  # сжато до total_width
    assert row_h[0] > 40.0  # длинный текст переносится → высокая строка


def test_table_layout_keeps_content_width_when_fits() -> None:
    col_w, _row_h = d2_miro._table_layout([["ab", "cd"]], 1000.0)
    assert col_w == [80.0, 80.0]  # короткий контент → минимальная ширина колонки


def test_table_layout_multiline_cell_increases_row_height() -> None:
    _col_w, row_h = d2_miro._table_layout([["a\nb\nc", "x"]], 1000.0)
    assert row_h == [84.0]  # 3 строки * 20 + 24 = 84


# ============================================================================
# _estimate_md_height
# ============================================================================


def test_estimate_md_height_text_only() -> None:
    assert d2_miro._estimate_md_height([("text", "<p>x</p>")], 600.0) == 104.0


def test_estimate_md_height_table_only() -> None:
    assert d2_miro._estimate_md_height([("table", [["a"], ["1"]])], 600.0) == 112.0


def test_estimate_md_height_text_then_table_is_compact() -> None:
    blocks: list[d2_miro.Block] = [("text", "<p>t</p>"), ("table", [["a"], ["1"]])]
    assert d2_miro._estimate_md_height(blocks, 600.0) == 154.0


def test_estimate_md_height_empty() -> None:
    assert d2_miro._estimate_md_height([], 600.0) == 0.0


def test_estimate_md_height_empty_table_adds_nothing() -> None:
    assert d2_miro._estimate_md_height([("table", [])], 600.0) == 0.0


# ============================================================================
# _parse_position / _build_frame_size / _to_miro_xy
# ============================================================================


def test_parse_position_none_and_empty() -> None:
    assert d2_miro._parse_position(None) is None
    assert d2_miro._parse_position("") is None


def test_parse_position_valid_with_spaces() -> None:
    assert d2_miro._parse_position(" 10 , 20 ") == (10.0, 20.0)


def test_parse_position_no_comma_raises() -> None:
    with pytest.raises(typer.BadParameter):
        d2_miro._parse_position("10")


def test_parse_position_non_numeric_raises() -> None:
    with pytest.raises(typer.BadParameter):
        d2_miro._parse_position("x,y")


def test_build_frame_size_is_one_to_one() -> None:
    assert d2_miro._build_frame_size(200.0, 100.0) == (200.0, 100.0, 1.0)


def test_to_miro_xy_centers_in_frame() -> None:
    mx, my, mw, mh = d2_miro._to_miro_xy(
        0.0, 0.0, 100.0, 50.0, 0.0, 0.0, 200.0, 100.0, 200.0, 100.0, 1.0
    )
    assert (mx, my, mw, mh) == (50.0, 25.0, 100.0, 50.0)


def test_to_miro_xy_applies_scale_to_size() -> None:
    _mx, _my, mw, mh = d2_miro._to_miro_xy(
        0.0, 0.0, 100.0, 50.0, 0.0, 0.0, 200.0, 100.0, 200.0, 100.0, 2.0
    )
    assert (mw, mh) == (200.0, 100.0)


# ============================================================================
# _render_markdown (фейковый клиент)
# ============================================================================


def test_render_markdown_text_block() -> None:
    rec = _Rec()
    client = _FakeMiroClient(rec, "tok", "board")
    end = d2_miro._render_markdown(
        client, frame_id="f", blocks=[("text", "<p>hi</p>")], x_center=300.0, y_top=0.0, width=400.0
    )
    assert end == 104.0
    assert len(rec.texts) == 1
    assert rec.texts[0].content_html == "<p>hi</p>"
    assert rec.texts[0].width == 400.0


def test_render_markdown_table_block_header_fill() -> None:
    rec = _Rec()
    client = _FakeMiroClient(rec, "tok", "board")
    end = d2_miro._render_markdown(
        client,
        frame_id="f",
        blocks=[("table", [["H1", "H2"], ["a", "b"]])],
        x_center=300.0,
        y_top=0.0,
        width=600.0,
    )
    assert end == 112.0
    assert len(rec.shapes) == 4
    assert rec.shapes[0].fill == "#e8eaf6"  # header row
    assert rec.shapes[2].fill == "#ffffff"  # body row


def test_render_markdown_text_before_table_compact() -> None:
    rec = _Rec()
    client = _FakeMiroClient(rec, "tok", "board")
    d2_miro._render_markdown(
        client,
        frame_id="f",
        blocks=[("text", "<p>Title</p>"), ("table", [["a", "b"], ["1", "2"]])],
        x_center=300.0,
        y_top=0.0,
        width=600.0,
    )
    assert len(rec.texts) == 1
    assert len(rec.shapes) == 4


def test_render_markdown_skips_on_text_error(capsys: pytest.CaptureFixture[str]) -> None:
    rec = _Rec(raise_text=True)
    client = _FakeMiroClient(rec, "tok", "board")
    end = d2_miro._render_markdown(
        client, frame_id="f", blocks=[("text", "<p>x</p>")], x_center=0.0, y_top=0.0, width=400.0
    )
    assert end == 104.0
    assert rec.texts == []
    assert "[skip] md text" in capsys.readouterr().err


def test_render_markdown_skips_on_table_cell_error(capsys: pytest.CaptureFixture[str]) -> None:
    rec = _Rec(raise_shape=True)
    client = _FakeMiroClient(rec, "tok", "board")
    end = d2_miro._render_markdown(
        client, frame_id="f", blocks=[("table", [["a"]])], x_center=0.0, y_top=0.0, width=600.0
    )
    assert end == 68.0
    assert rec.shapes == []
    assert "[skip] md table cell" in capsys.readouterr().err


def test_render_markdown_text_before_empty_table() -> None:
    # Текст-заголовок перед таблицей с пустыми строками: текст рендерится в компактном
    # режиме (text_width=width), а сама пустая таблица пропускается.
    rec = _Rec()
    client = _FakeMiroClient(rec, "tok", "board")
    d2_miro._render_markdown(
        client,
        frame_id="f",
        blocks=[("text", "<p>T</p>"), ("table", [])],
        x_center=0.0,
        y_top=0.0,
        width=600.0,
    )
    assert len(rec.texts) == 1
    assert rec.texts[0].width == 600.0
    assert rec.shapes == []


def test_render_markdown_empty_table_skipped() -> None:
    rec = _Rec()
    client = _FakeMiroClient(rec, "tok", "board")
    end = d2_miro._render_markdown(
        client, frame_id="f", blocks=[("table", [])], x_center=0.0, y_top=5.0, width=600.0
    )
    assert end == 5.0
    assert rec.shapes == []


# ============================================================================
# _ensure_svg
# ============================================================================


def test_ensure_svg_skip_render_returns_existing(tmp_path: Path) -> None:
    d2 = _write_pair(tmp_path)
    assert d2_miro._ensure_svg(d2, skip_render=True) == d2.with_suffix(".svg")


def test_ensure_svg_returns_fresh_existing(tmp_path: Path) -> None:
    d2 = _write_pair(tmp_path)  # .svg создан новее .d2
    assert d2_miro._ensure_svg(d2, skip_render=False) == d2.with_suffix(".svg")


def test_ensure_svg_missing_and_no_binary_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path, with_svg=False)
    monkeypatch.setattr(d2_miro.shutil, "which", _which_none)
    with pytest.raises(RuntimeError, match="d2 CLI is not in PATH"):
        d2_miro._ensure_svg(d2, skip_render=False)


def test_ensure_svg_renders_when_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path, with_svg=False)
    calls: list[list[str]] = []

    def _fake_run(cmd: list[str], check: bool = False) -> int:
        _ = check
        calls.append(cmd)
        return 0

    monkeypatch.setattr(d2_miro.shutil, "which", _which_found)
    monkeypatch.setattr(d2_miro.subprocess, "run", _fake_run)
    out = d2_miro._ensure_svg(d2, skip_render=False)
    assert out == d2.with_suffix(".svg")
    assert calls == [["d2", str(d2), str(d2.with_suffix(".svg"))]]


def test_ensure_svg_stale_no_binary_warns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    d2 = tmp_path / "d.d2"
    d2.write_text('a: "A"\n', encoding="utf-8")
    svg = tmp_path / "d.svg"
    svg.write_text("<svg/>", encoding="utf-8")
    st = d2.stat()
    os.utime(svg, (st.st_atime - 100, st.st_mtime - 100))  # svg СТАРЕЕ .d2
    monkeypatch.setattr(d2_miro.shutil, "which", _which_none)
    out = d2_miro._ensure_svg(d2, skip_render=False)
    assert out == svg
    assert "[warn] d2 CLI not found" in capsys.readouterr().err


def test_ensure_svg_stale_rerenders_with_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = tmp_path / "d.d2"
    d2.write_text('a: "A"\n', encoding="utf-8")
    svg = tmp_path / "d.svg"
    svg.write_text("<svg/>", encoding="utf-8")
    st = d2.stat()
    os.utime(svg, (st.st_atime - 100, st.st_mtime - 100))
    calls: list[list[str]] = []

    def _fake_run(cmd: list[str], check: bool = False) -> int:
        _ = check
        calls.append(cmd)
        return 0

    monkeypatch.setattr(d2_miro.shutil, "which", _which_found)
    monkeypatch.setattr(d2_miro.subprocess, "run", _fake_run)
    assert d2_miro._ensure_svg(d2, skip_render=False) == svg
    assert calls == [["d2", str(d2), str(svg)]]


# ============================================================================
# CLI: dry-run
# ============================================================================


def test_cli_dry_run_lists_plan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"c1": _d2("card", "C1"), "c2": _d2("card", "C2"), "r": _d2("rectangle", "R")}
    layout = {
        "c1": _layout(0, 0, 50, 30),
        "c2": _layout(60, 0, 50, 30),
        "r": _layout(0, 60, 50, 30),
    }
    svg_edges = [Edge("c1", "c2", "link"), Edge("r", "ghost", "")]
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=svg_edges)
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2), "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "[dry-run] would create:" in result.output
    assert "kind=card" in result.output
    assert "[skipped: card→card]" in result.output
    assert "edge   r -> ghost" in result.output
    assert rec.frames == []  # API не дёргался


# ============================================================================
# CLI: happy-path и варианты
# ============================================================================


def test_cli_happy_flow_basic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "Node A"), "b": _d2("rectangle", "Node B")}
    layout = {"a": _layout(0, 0, 50, 30, "Node A"), "b": _layout(60, 0, 50, 30, "Node B")}
    svg_edges = [Edge("a", "b", "go")]
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=svg_edges)
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.init_args == ("tok", "board")
    assert len(rec.frames) == 1
    assert rec.frames[0].title == "diagram"
    assert rec.frames[0].width == 200.0
    assert [s.kind for s in rec.shapes] == ["rectangle", "rectangle"]
    assert "Node A" in rec.shapes[0].content_html
    assert len(rec.connectors) == 1
    assert rec.connectors[0].src_id == "shape-1"
    assert rec.connectors[0].dst_id == "shape-2"
    assert "go" in rec.connectors[0].label
    assert rec.connectors[0].snap_start is None
    assert "[done]" in result.output


def test_cli_idempotent_reuses_existing_frame_position(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A")}
    layout = {"a": _layout(0, 0, 50, 30, "A")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec(existing_frame=FrameRef(id="old", title="diagram", x=999.0, y=888.0, w=10.0, h=10.0))
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.deleted == ["old"]  # старый фрейм удалён
    assert (rec.frames[0].x, rec.frames[0].y) == (999.0, 888.0)  # позиция переиспользована


def test_cli_position_and_board_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch, board=None)  # MIRO_BOARD_ID не задан → должен помочь --board
    d2_shapes = {"a": _d2("rectangle", "A")}
    layout = {"a": _layout(0, 0, 50, 30, "A")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2), "--position", "5,7", "--board", "bd"])
    assert result.exit_code == 0, result.output
    assert rec.init_args == ("tok", "bd")
    assert (rec.frames[0].x, rec.frames[0].y) == (5.0, 7.0)
    assert rec.deleted == []


def test_cli_title_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    _patch_pipeline(
        monkeypatch,
        d2_shapes={"a": _d2("rectangle", "A")},
        layout={"a": _layout(0, 0, 50, 30, "A")},
        svg_edges=[],
    )
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2), "--title", "Custom", "--skip-render"])
    assert result.exit_code == 0, result.output
    assert rec.frames[0].title == "Custom"
    assert "frame='Custom'" in result.output


def test_cli_container_and_cards(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {
        "grp": _d2("rectangle", "Group"),
        "grp.header": _d2("card", "Header"),
        "grp.c1": _d2("card", "Card1"),
        "grp.c2": _d2("card", "Card2"),
    }
    layout = {
        "grp": _layout(0, 0, 300, 200, "Group"),
        "grp.header": _layout(10, 40, 80, 30, "Header"),
        "grp.c1": _layout(10, 80, 80, 30, "Card1"),
        "grp.c2": _layout(10, 120, 80, 30, "Card2"),
    }
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert [s.kind for s in rec.shapes] == [
        "rectangle",
        "round_rectangle",
        "round_rectangle",
        "round_rectangle",
    ]
    # контейнер: полупрозрачная заливка + штриховая рамка
    assert rec.shapes[0].fill_opacity == "0.5"
    assert rec.shapes[0].border_style == "dashed"
    # карточки: жёлтая рамка по умолчанию
    assert rec.shapes[1].border_color == "#ffd54f"


def test_cli_container_without_header_skips_indent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Контейнер с единственной card-без-header: L-indent не применяется (continue),
    # но контейнер и карточка всё равно рендерятся.
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"grp": _d2("rectangle", "Group"), "grp.x": _d2("card", "X")}
    layout = {"grp": _layout(0, 0, 200, 120, "Group"), "grp.x": _layout(10, 40, 80, 30, "X")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert [s.kind for s in rec.shapes] == ["rectangle", "round_rectangle"]


def test_cli_invisible_border_for_none_stroke(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A", stroke="none")}
    layout = {"a": _layout(0, 0, 50, 30, "A")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.shapes[0].border_width == "0"
    assert rec.shapes[0].border_color == "#ffffff"


def test_cli_markdown_summary_render_failure_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A"), "summary": _d2("markdown", "# T")}
    layout = {"a": _layout(0, 0, 50, 30, "A")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)

    def _boom(
        client: MiroClient,
        *,
        frame_id: str,
        blocks: list[d2_miro.Block],
        x_center: float,
        y_top: float,
        width: float,
    ) -> float:
        _ = client, frame_id, blocks, x_center, y_top, width
        raise RuntimeError("render exploded")

    monkeypatch.setattr(d2_miro, "_render_markdown", _boom)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert "[skip] markdown summary" in result.output


def test_cli_markdown_shape_in_layout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"note": _d2("markdown", "Hello **world**")}
    layout = {"note": _layout(0, 0, 100, 40)}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert len(rec.texts) == 1
    assert rec.texts[0].content_html == "<p>Hello **world**</p>"
    assert rec.shapes == []


def test_cli_markdown_summary_block_with_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {
        "a": _d2("rectangle", "A"),
        "summary": _d2("markdown", "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
    }
    layout = {"a": _layout(0, 0, 50, 30, "A")}  # summary НЕ в layout → md_only_in_d2
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert "1 markdown blocks" in result.output
    assert len(rec.texts) == 1  # заголовок summary
    assert len(rec.shapes) == 5  # 1 прямоугольник + 4 ячейки таблицы 2x2


def test_cli_warns_on_shape_set_mismatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A"), "y": _d2("rectangle", "Y")}
    layout = {"a": _layout(0, 0, 50, 30, "A"), "x": _layout(60, 0, 50, 30, "X")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert "[warn] in SVG but not in d2 source: ['x']" in result.output
    assert "[warn] in d2 source but not in SVG: ['y']" in result.output


def test_cli_bidirectional_edges_get_snap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A"), "b": _d2("rectangle", "B")}
    layout = {"a": _layout(0, 0, 50, 30, "A"), "b": _layout(60, 0, 50, 30, "B")}
    svg_edges = [Edge("a", "b", "f"), Edge("b", "a", "r")]
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=svg_edges)
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert len(rec.connectors) == 2
    assert (rec.connectors[0].snap_start, rec.connectors[0].snap_end) == ("top", "top")
    assert (rec.connectors[1].snap_start, rec.connectors[1].snap_end) == ("bottom", "bottom")


def test_cli_connector_skipped_when_shape_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A")}
    layout = {"a": _layout(0, 0, 50, 30, "A")}
    svg_edges = [Edge("a", "ghost", "")]
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=svg_edges)
    rec = _Rec()
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.connectors == []
    assert "[skip] edge a -> ghost" in result.output


def test_cli_shape_error_is_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A"), "b": _d2("rectangle", "B")}
    layout = {"a": _layout(0, 0, 50, 30, "A"), "b": _layout(60, 0, 50, 30, "B")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec(raise_shape=True)
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.shapes == []
    assert "[skip] shape a" in result.output


def test_cli_connector_error_is_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"a": _d2("rectangle", "A"), "b": _d2("rectangle", "B")}
    layout = {"a": _layout(0, 0, 50, 30, "A"), "b": _layout(60, 0, 50, 30, "B")}
    svg_edges = [Edge("a", "b", "x")]
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=svg_edges)
    rec = _Rec(raise_connector=True)
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert rec.connectors == []
    assert "[skip] connector a -> b" in result.output


def test_cli_card_error_is_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"c": _d2("card", "C")}
    layout = {"c": _layout(0, 0, 50, 30, "C")}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec(raise_shape=True)
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert "[skip] card c" in result.output


def test_cli_markdown_shape_error_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch)
    d2_shapes = {"note": _d2("markdown", "Hi")}
    layout = {"note": _layout(0, 0, 100, 40)}
    _patch_pipeline(monkeypatch, d2_shapes=d2_shapes, layout=layout, svg_edges=[])
    rec = _Rec(raise_text=True)
    _install_client(monkeypatch, rec)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code == 0, result.output
    assert "[skip] markdown note" in result.output


# ============================================================================
# CLI: ошибки
# ============================================================================


def test_cli_missing_token_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch, token=None)
    result = runner.invoke(d2_miro.app, [str(d2), "--dry-run"])
    assert result.exit_code != 0
    assert isinstance(result.exception, RuntimeError)


def test_cli_missing_board_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path)
    _patch_env(monkeypatch, board=None)  # и без --board
    result = runner.invoke(d2_miro.app, [str(d2), "--dry-run"])
    assert result.exit_code != 0
    assert isinstance(result.exception, RuntimeError)


def test_cli_missing_d2_binary_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    d2 = _write_pair(tmp_path, with_svg=False)
    _patch_env(monkeypatch)
    monkeypatch.setattr(d2_miro.shutil, "which", _which_none)
    result = runner.invoke(d2_miro.app, [str(d2)])
    assert result.exit_code != 0
    assert isinstance(result.exception, RuntimeError)


def test_cli_file_not_found_is_usage_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_env(monkeypatch)
    result = runner.invoke(d2_miro.app, [str(tmp_path / "nope.d2")])
    assert result.exit_code == 2
