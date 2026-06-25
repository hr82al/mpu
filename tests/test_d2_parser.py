"""Тесты парсера d2-исходника и SVG (`lib/d2_parser.py`).

Чистые функции, без сети/БД/IO — конструируем входные строки и сверяем разбор.
Покрываем то, что ломается тихо: парсинг команд path, экранирование, иерархия
шейпов, markdown-блоки с разным числом пайпов, пустой/мусорный вход, fallback'и.
"""
# pyright: reportPrivateUsage=false

import base64
import xml.etree.ElementTree as ET

from mpu.lib.d2_parser import (
    D2Shape,
    Edge,
    LayoutShape,
    _b64dec,
    _path_bbox,
    _text_lines,
    _unescape,
    container_names,
    normalize_hex,
    parse_d2_source,
    parse_svg,
    to_miro_shape,
)

SVG_NS = "http://www.w3.org/2000/svg"


# ---------- helpers ----------


def _b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def _wrap(body: str, *, inner_viewbox: str | None = "0 0 800 600") -> str:
    """Обёртка корневого <svg> + (опц.) вложенного <svg> с viewBox (как у d2)."""
    if inner_viewbox is None:
        return f'<svg xmlns="{SVG_NS}">{body}</svg>'
    return f'<svg xmlns="{SVG_NS}"><svg viewBox="{inner_viewbox}">{body}</svg></svg>'


def _shape_g(name: str, inner_shape: str, *, text: str | None = None, extra_cls: str = "") -> str:
    cls = _b64(name) + extra_cls
    t = f"<text>{text}</text>" if text is not None else ""
    return f'<g class="{cls}"><g class="shape">{inner_shape}</g>{t}</g>'


def _edge_g(name: str, *, text: str | None = None) -> str:
    t = f"<text>{text}</text>" if text is not None else ""
    return f'<g class="{_b64(name)}">{t}</g>'


# ---------- _unescape ----------


def test_unescape_newline() -> None:
    assert _unescape("a\\nb") == "a\nb"


def test_unescape_tab() -> None:
    assert _unescape("a\\tb") == "a\tb"


def test_unescape_quote() -> None:
    assert _unescape('say \\"hi\\"') == 'say "hi"'


def test_unescape_double_backslash_preserved() -> None:
    # `\\` (две обратных косых в литерале) → одна обратная косая, без интерпретации n
    assert _unescape("\\\\n") == "\\n"


def test_unescape_mixed() -> None:
    assert _unescape("a\\nb\\tc\\\\d") == "a\nb\tc\\d"


def test_unescape_empty() -> None:
    assert _unescape("") == ""


def test_unescape_no_escapes_passthrough() -> None:
    assert _unescape("plain text") == "plain text"


# ---------- parse_d2_source ----------


def test_parse_leaf_rectangle() -> None:
    shapes, edges = parse_d2_source('box: "Hello"')
    assert edges == []
    assert shapes == {"box": D2Shape(kind="rectangle", label="Hello", fill=None)}


def test_parse_nested_full_path() -> None:
    src = """triggers {
  dataLoader: "Loader"
}"""
    shapes, _ = parse_d2_source(src)
    assert "triggers" in shapes
    assert shapes["triggers"].label == "triggers"
    assert shapes["triggers.dataLoader"] == D2Shape(kind="rectangle", label="Loader", fill=None)


def test_parse_shape_property() -> None:
    src = """db {
  shape: cylinder
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["db"].kind == "cylinder"


def test_parse_style_fill_and_stroke() -> None:
    src = """box {
  style.fill: "#ff0000"
  style.stroke: "#000000"
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["box"].fill == "#ff0000"
    assert shapes["box"].stroke == "#000000"


def test_parse_class_card_sentinel() -> None:
    src = """mycard {
  class: card
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["mycard"].kind == "card"


def test_parse_class_non_card_does_not_change_kind() -> None:
    # class != card матчится правилом, но kind остаётся rectangle
    src = """box {
  class: important
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["box"].kind == "rectangle"


def test_parse_connection_without_label() -> None:
    _, edges = parse_d2_source("a -> b")
    assert edges == [Edge("a", "b", "")]


def test_parse_connection_with_label() -> None:
    _, edges = parse_d2_source('a -> b: "calls"')
    assert edges == [Edge("a", "b", "calls")]


def test_parse_connection_dotted_paths() -> None:
    _, edges = parse_d2_source('loader.x -> loader.y: "flow"')
    assert edges == [Edge("loader.x", "loader.y", "flow")]


def test_label_containing_arrow_is_not_an_edge() -> None:
    # лейбл со стрелкой не должен распознаваться как связь
    shapes, edges = parse_d2_source('note: "a -> b"')
    assert edges == []
    assert shapes["note"].label == "a -> b"


def test_parse_markdown_block_simple() -> None:
    src = """note: |md
# Title
content
|"""
    shapes, _ = parse_d2_source(src)
    assert shapes["note"].kind == "markdown"
    assert shapes["note"].label == "# Title\ncontent"


def test_parse_markdown_pipe_count_match() -> None:
    # тройные пайпы закрываются только тройными; одиночный/`||| words` — это контент
    src = """big: |||md
| single pipe inside
||| trailing words
|||"""
    shapes, _ = parse_d2_source(src)
    assert shapes["big"].label == "| single pipe inside\n||| trailing words"


def test_parse_markdown_single_line_modifier_close() -> None:
    # закрытие вида `| { near: ... }` на одной строке — модификатор отбрасывается
    src = """note: |md
body
| { near: bottom }"""
    shapes, _ = parse_d2_source(src)
    assert shapes["note"].label == "body"


def test_parse_markdown_modifier_block_consumed() -> None:
    # блок-модификатор `{ ... }` после закрывающего пайпа полностью проглатывается,
    # его содержимое не превращается в шейпы
    src = """note: |md
content
|
{
  inner: "Should not appear"
}
after: "After\""""
    shapes, _ = parse_d2_source(src)
    assert shapes["note"].kind == "markdown"
    assert "inner" not in shapes
    assert "after" in shapes


def test_parse_markdown_runs_to_eof() -> None:
    # незакрытый md-блок добирает до конца файла, не падает
    src = """note: |md
line one
line two"""
    shapes, _ = parse_d2_source(src)
    assert shapes["note"].kind == "markdown"
    assert shapes["note"].label == "line one\nline two"


def test_parse_comments_and_blank_lines_ignored() -> None:
    src = """# this is a comment

box: "Box"
   # indented comment
"""
    shapes, edges = parse_d2_source(src)
    assert edges == []
    assert list(shapes.keys()) == ["box"]


def test_parse_style_block_not_parsed_as_shape() -> None:
    # `style: { ... }` — инлайн-стили, его поля не становятся вложенными шейпами
    src = """box {
  style: {
    fill: "#eeeeee"
    bold: true
  }
}"""
    shapes, _ = parse_d2_source(src)
    assert "box" in shapes
    assert "box.fill" not in shapes
    assert "box.style" not in shapes


def test_parse_classes_block_nested() -> None:
    src = """classes {
  important {
    style.fill: "#ff0000"
  }
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["classes.important"].fill == "#ff0000"


def test_parse_block_opener_with_label() -> None:
    src = """group: "My Group" {
  child: "Child"
}"""
    shapes, _ = parse_d2_source(src)
    assert shapes["group"].label == "My Group"
    assert shapes["group.child"].label == "Child"


def test_parse_leaf_relabels_existing_block() -> None:
    # шейп создан как блок, затем лист с тем же путём переписывает label
    src = """db {
  shape: cylinder
}
db: "Database\""""
    shapes, _ = parse_d2_source(src)
    assert shapes["db"].kind == "cylinder"
    assert shapes["db"].label == "Database"


def test_parse_stray_closing_brace_no_crash() -> None:
    # лишняя `}` без открытого блока не должна падать
    shapes, _ = parse_d2_source('}\nbox: "Box"')
    assert "box" in shapes


def test_parse_empty_input() -> None:
    shapes, edges = parse_d2_source("")
    assert shapes == {}
    assert edges == []


def test_parse_unescape_applied_to_labels() -> None:
    shapes, _ = parse_d2_source(r'box: "line1\nline2"')
    assert shapes["box"].label == "line1\nline2"


def test_parse_markdown_modifier_block_runs_to_eof() -> None:
    # незакрытый блок-модификатор после md добирает до конца файла без падения
    src = """note: |md
content
|
{
  unclosed: "x\""""
    shapes, _ = parse_d2_source(src)
    assert shapes["note"].kind == "markdown"
    assert "unclosed" not in shapes


def test_parse_style_block_with_nested_braces() -> None:
    # вложенные `{}` внутри style-блока корректно балансируются и пропускаются
    src = """box {
  style: {
    shadow: {
      on: true
    }
  }
}"""
    shapes, _ = parse_d2_source(src)
    assert list(shapes.keys()) == ["box"]


def test_parse_unmatched_line_ignored() -> None:
    # строка `key: value` без кавычек на верхнем уровне не матчит ни одно правило
    shapes, _ = parse_d2_source('randomkey: somevalue\nbox: "B"')
    assert list(shapes.keys()) == ["box"]


# ---------- _b64dec ----------


def test_b64dec_valid_roundtrip() -> None:
    assert _b64dec(_b64("triggers")) == "triggers"


def test_b64dec_re_adds_stripped_padding() -> None:
    stripped = _b64("tr").rstrip("=")
    assert "=" not in stripped
    assert _b64dec(stripped) == "tr"


def test_b64dec_invalid_returns_none() -> None:
    # длина mod 4 == 1 нельзя дополнить до валидного base64
    assert _b64dec("a") is None


# ---------- _path_bbox ----------


def test_path_bbox_absolute_m_l() -> None:
    assert _path_bbox("M10 20 L30 40") == (10.0, 20.0, 30.0, 40.0)


def test_path_bbox_relative_m_l() -> None:
    # после относительного m последующие пары трактуются относительно
    assert _path_bbox("m10 20 l5 5") == (10.0, 20.0, 15.0, 25.0)


def test_path_bbox_implicit_lineto_after_m() -> None:
    # лишние числа после M идут как implicit L
    assert _path_bbox("M10 20 30 40") == (10.0, 20.0, 30.0, 40.0)


def test_path_bbox_h_v_absolute() -> None:
    assert _path_bbox("M0 0 H50 V30") == (0.0, 0.0, 50.0, 30.0)


def test_path_bbox_h_v_relative() -> None:
    assert _path_bbox("M10 10 h20 v20") == (10.0, 10.0, 30.0, 30.0)


def test_path_bbox_cubic_control_points_included() -> None:
    assert _path_bbox("M0 0 C10 10 20 20 30 30") == (0.0, 0.0, 30.0, 30.0)


def test_path_bbox_cubic_relative() -> None:
    assert _path_bbox("M0 0 c10 10 20 20 30 30") == (0.0, 0.0, 30.0, 30.0)


def test_path_bbox_smooth_and_quad() -> None:
    assert _path_bbox("M0 0 S10 10 20 20") == (0.0, 0.0, 20.0, 20.0)
    assert _path_bbox("M0 0 Q10 20 30 40") == (0.0, 0.0, 30.0, 40.0)


def test_path_bbox_smooth_quad_t_commands() -> None:
    # T трактуется как L (2 аргумента)
    assert _path_bbox("M0 0 T10 10") == (0.0, 0.0, 10.0, 10.0)


def test_path_bbox_arc_endpoint_only() -> None:
    # дуга: в bbox только эндпоинт, радиусы игнорируются
    assert _path_bbox("M0 0 A5 5 0 0 1 50 60") == (0.0, 0.0, 50.0, 60.0)


def test_path_bbox_arc_relative() -> None:
    assert _path_bbox("M10 10 a5 5 0 0 1 20 20") == (10.0, 10.0, 30.0, 30.0)


def test_path_bbox_close_resets_to_start() -> None:
    assert _path_bbox("M0 0 L10 10 Z") == (0.0, 0.0, 10.0, 10.0)


def test_path_bbox_empty_returns_none() -> None:
    assert _path_bbox("") is None


def test_path_bbox_only_numbers_no_command_returns_none() -> None:
    # числа без ведущей команды → cmd is None, ничего не накапливается
    assert _path_bbox("10 20") is None


def test_path_bbox_truncated_args_break() -> None:
    # L требует 2 числа, но осталось одно → выходим, остаётся только точка M
    assert _path_bbox("M0 0 L10") == (0.0, 0.0, 0.0, 0.0)


# ---------- _text_lines ----------


def test_text_lines_multi_tspan() -> None:
    el = ET.fromstring(f'<text xmlns="{SVG_NS}">Head<tspan>One</tspan><tspan>Two</tspan></text>')
    assert _text_lines(el) == "Head\nOne\nTwo"


def test_text_lines_empty_element() -> None:
    el = ET.fromstring(f'<text xmlns="{SVG_NS}"></text>')
    assert _text_lines(el) == ""


def test_text_lines_skips_empty_tspan() -> None:
    # пустой <tspan> без текста не добавляет строку
    el = ET.fromstring(f'<text xmlns="{SVG_NS}">A<tspan></tspan><tspan>C</tspan></text>')
    assert _text_lines(el) == "A\nC"


# ---------- parse_svg ----------


def test_parse_svg_viewbox_from_inner() -> None:
    _, _, vb = parse_svg(_wrap(""))
    assert vb == (0.0, 0.0, 800.0, 600.0)


def test_parse_svg_viewbox_from_root_when_no_inner() -> None:
    svg = f'<svg xmlns="{SVG_NS}" viewBox="0 0 500 400"></svg>'
    _, _, vb = parse_svg(svg)
    assert vb == (0.0, 0.0, 500.0, 400.0)


def test_parse_svg_viewbox_default_fallback() -> None:
    _, _, vb = parse_svg(f'<svg xmlns="{SVG_NS}"></svg>')
    assert vb == (0.0, 0.0, 1000.0, 1000.0)


def test_parse_svg_rect_shape() -> None:
    body = _shape_g(
        "box",
        '<rect x="10" y="20" width="100" height="50" fill="#ff0000"/>',
        text="Box Label",
    )
    layout, _, _ = parse_svg(_wrap(body))
    assert layout["box"] == LayoutShape(
        x=10.0, y=20.0, w=100.0, h=50.0, label="Box Label", fill="#ff0000"
    )


def test_parse_svg_rect_defaults_and_no_fill() -> None:
    # rect без x/y/fill → координаты 0, fill None
    body = _shape_g("minrect", '<rect width="10" height="10"/>')
    layout, _, _ = parse_svg(_wrap(body))
    shape = layout["minrect"]
    assert (shape.x, shape.y, shape.w, shape.h) == (0.0, 0.0, 10.0, 10.0)
    assert shape.fill is None
    assert shape.label == ""


def test_parse_svg_path_shape_bbox() -> None:
    body = _shape_g(
        "cyl",
        '<path d="M10 10 L60 10 L60 40 L10 40 Z" fill="#00ff00"/>',
        text="Cyl",
    )
    layout, _, _ = parse_svg(_wrap(body))
    shape = layout["cyl"]
    assert (shape.x, shape.y, shape.w, shape.h) == (10.0, 10.0, 50.0, 30.0)
    assert shape.fill == "#00ff00"


def test_parse_svg_path_empty_d_skipped() -> None:
    body = _shape_g("emptypath", '<path d=""/>')
    layout, _, _ = parse_svg(_wrap(body))
    assert "emptypath" not in layout


def test_parse_svg_multi_tspan_label() -> None:
    body = _shape_g(
        "box",
        '<rect x="0" y="0" width="5" height="5"/>',
        text="A<tspan>B</tspan><tspan>C</tspan>",
    )
    layout, _, _ = parse_svg(_wrap(body))
    assert layout["box"].label == "A\nB\nC"


def test_parse_svg_edge_simple() -> None:
    body = _edge_g("(a -> b)[0]", text="calls")
    _, edges, _ = parse_svg(_wrap(body))
    assert edges == [Edge("a", "b", "calls")]


def test_parse_svg_edge_with_prefix() -> None:
    body = _edge_g("loader.(x -> y)")
    _, edges, _ = parse_svg(_wrap(body))
    assert edges == [Edge("loader.x", "loader.y", "")]


def test_parse_svg_edge_no_paren_skipped() -> None:
    # содержит "->" но не матчит шаблон связи → пропускается
    body = _edge_g("a -> b nomatch")
    _, edges, _ = parse_svg(_wrap(body))
    assert edges == []


def test_parse_svg_skips_undecodable_and_classless_g() -> None:
    body = '<g class="a"></g><g></g>'
    layout, edges, _ = parse_svg(_wrap(body))
    assert layout == {}
    assert edges == []


def test_parse_svg_g_without_inner_shape_skipped() -> None:
    body = f'<g class="{_b64("noshape")}"></g>'
    layout, _, _ = parse_svg(_wrap(body))
    assert "noshape" not in layout


def test_parse_svg_multi_token_class_uses_first() -> None:
    # class="<base64> важный-класс" — берём первый токен
    body = _shape_g(
        "box",
        '<rect x="1" y="2" width="3" height="4"/>',
        extra_cls=" important",
    )
    layout, _, _ = parse_svg(_wrap(body))
    assert "box" in layout


# ---------- to_miro_shape ----------


def test_to_miro_shape_known_cylinder() -> None:
    assert to_miro_shape("cylinder") == "can"


def test_to_miro_shape_unknown_fallback_rectangle() -> None:
    assert to_miro_shape("totally-unknown") == "rectangle"


def test_to_miro_shape_page_maps_to_predefined_process() -> None:
    assert to_miro_shape("page") == "flow_chart_predefined_process"


# ---------- container_names ----------


def test_container_names_collects_parents() -> None:
    out = container_names(["a.b", "a.c", "x.y.z", "lonely"])
    assert out == {"a", "x.y"}


def test_container_names_empty() -> None:
    assert container_names([]) == set()


# ---------- normalize_hex ----------


def test_normalize_hex_none_fallback() -> None:
    assert normalize_hex(None) == "#ffffff"


def test_normalize_hex_short_valid_passthrough() -> None:
    assert normalize_hex("#fff") == "#fff"


def test_normalize_hex_long_valid_passthrough() -> None:
    assert normalize_hex("#ff00aa") == "#ff00aa"


def test_normalize_hex_strips_whitespace() -> None:
    assert normalize_hex("  #abc  ") == "#abc"


def test_normalize_hex_missing_hash_fallback() -> None:
    assert normalize_hex("red") == "#ffffff"


def test_normalize_hex_wrong_length_fallback() -> None:
    assert normalize_hex("#fffff") == "#ffffff"


def test_normalize_hex_empty_string_fallback() -> None:
    assert normalize_hex("") == "#ffffff"


def test_normalize_hex_custom_fallback() -> None:
    assert normalize_hex(None, "#000000") == "#000000"
