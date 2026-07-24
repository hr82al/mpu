"""Тесты OOXML-ридера (mpu.lib.xlsx_reader).

Фикстуры собираются вручную через `zipfile` — минимальный валидный .xlsx без
внешних writer-зависимостей. Так тест управляет ровно теми деталями формата,
ради которых ридер и написан: implicit-индексация без атрибута `r`, rich-text
sharedStrings, XML-entities, merged cells, ячейки-ошибки.

Контракт частично портирован из new-mpu/tests/xlsx.test.ts.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from mpu.lib.sheet_cache import parse_range
from mpu.lib.xlsx_reader import XlsxError, XlsxFile

_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _workbook(names: list[str]) -> str:
    sheets = "".join(
        f'<sheet name="{name}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
        for i, name in enumerate(names)
    )
    return (
        f'<?xml version="1.0"?><workbook xmlns:r="{_RELS_NS}"><sheets>{sheets}</sheets></workbook>'
    )


def _rels(count: int) -> str:
    rels = "".join(
        f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml"/>'
        for i in range(count)
    )
    return f'<?xml version="1.0"?><Relationships>{rels}</Relationships>'


def _sheet(rows_xml: str, *, merges: str = "") -> str:
    merge_block = ""
    if merges:
        refs = "".join(f'<mergeCell ref="{ref}"/>' for ref in merges.split())
        merge_block = f'<mergeCells count="{len(merges.split())}">{refs}</mergeCells>'
    return (
        f'<?xml version="1.0"?><worksheet><sheetData>{rows_xml}</sheetData>'
        f"{merge_block}</worksheet>"
    )


def _shared(items: list[str]) -> str:
    body = "".join(f"<si><t>{item}</t></si>" for item in items)
    return f'<?xml version="1.0"?><sst>{body}</sst>'


def _build(tmp_path: Path, sheets: dict[str, str], *, shared: str | None = None) -> Path:
    """Собрать .xlsx: {имя листа: xml листа}."""
    path = tmp_path / "book.xlsx"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("xl/workbook.xml", _workbook(list(sheets)))
        zf.writestr("xl/_rels/workbook.xml.rels", _rels(len(sheets)))
        if shared is not None:
            zf.writestr("xl/sharedStrings.xml", shared)
        for i, xml in enumerate(sheets.values()):
            zf.writestr(f"xl/worksheets/sheet{i + 1}.xml", xml)
    return path


def _refs(*ranges: str):
    return [parse_range(r) for r in ranges]


# ────────────────────────────────────────────────────────────────────────────
# Листы
# ────────────────────────────────────────────────────────────────────────────


def test_list_sheets_returns_titles_indices_and_dimensions(tmp_path: Path) -> None:
    """Проверяет: ls отдаёт имена, индексы и размеры maxRow×maxCol."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1" t="str"><v>a</v></c></row>'
                '<row r="3"><c r="C3" t="str"><v>b</v></c></row>'
            ),
            "Empty": _sheet(""),
        },
    )
    summaries = XlsxFile.open(book).list_sheets()
    assert [(s.title, s.index, s.rows, s.cols) for s in summaries] == [
        ("Data", 0, 3, 3),
        ("Empty", 1, 0, 0),
    ]


def test_missing_workbook_is_rejected(tmp_path: Path) -> None:
    """Проверяет: zip без xl/workbook.xml — не xlsx."""
    path = tmp_path / "fake.xlsx"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("hello.txt", "not a workbook")
    with pytest.raises(XlsxError, match=r"missing xl/workbook\.xml"):
        XlsxFile.open(path)


def test_non_zip_file_is_rejected(tmp_path: Path) -> None:
    """Проверяет: произвольный файл — понятная ошибка, не traceback zipfile."""
    path = tmp_path / "junk.xlsx"
    path.write_text("plain text")
    with pytest.raises(XlsxError, match="not a zip archive"):
        XlsxFile.open(path)


def test_unknown_sheet_lists_available(tmp_path: Path) -> None:
    """Проверяет: несуществующий лист → перечень доступных."""
    book = _build(tmp_path, {"Data": _sheet(""), "Empty": _sheet("")})
    with pytest.raises(XlsxError, match="Available: Data, Empty"):
        XlsxFile.open(book).read_ranges(_refs("Nope!A1"))


# ────────────────────────────────────────────────────────────────────────────
# Значения и формулы
# ────────────────────────────────────────────────────────────────────────────


def test_read_ranges_is_dense_and_typed(tmp_path: Path) -> None:
    """Проверяет: прямоугольник отдаётся целиком, пустые ячейки = None, числа — числа."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
                '<row r="2"><c r="A2"><v>5</v></c></row>'
            )
        },
        shared=_shared(["name", "clicks"]),
    )
    cells = XlsxFile.open(book).read_ranges(_refs("Data!A1:B2"))
    assert [(c.range, c.value) for c in cells] == [
        ("Data!A1", "name"),
        ("Data!B1", "clicks"),
        ("Data!A2", 5),
        ("Data!B2", None),
    ]


def test_formula_present_only_where_it_exists(tmp_path: Path) -> None:
    """Проверяет: formula только у реальных формул, значение берётся из кэша <v>."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>A1*2</f><v>10</v></c></row>'
            )
        },
    )
    cells = XlsxFile.open(book).read_ranges(_refs("Data!A1:B1"))
    assert cells[0].formula is None
    assert cells[1].formula == "=A1*2"
    assert cells[1].value == 10


def test_error_cell_keeps_its_text(tmp_path: Path) -> None:
    """Проверяет: ячейка типа `e` отдаёт текст ошибки (отличие от прежней реализации)."""
    book = _build(
        tmp_path,
        {"Data": _sheet('<row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>')},
    )
    cell = XlsxFile.open(book).read_ranges(_refs("Data!A1"))[0]
    assert cell.value == "#DIV/0!"
    assert cell.formula == "=1/0"


def test_boolean_and_inline_string_types(tmp_path: Path) -> None:
    """Проверяет: `b` → bool, `inlineStr` → текст из <is>."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>'
                '<c r="C1" t="inlineStr"><is><t>inline</t></is></c></row>'
            )
        },
    )
    cells = XlsxFile.open(book).read_ranges(_refs("Data!A1:C1"))
    assert [c.value for c in cells] == [True, False, "inline"]


def test_rich_text_runs_are_concatenated(tmp_path: Path) -> None:
    """Проверяет: sharedString из ранов <r><t> склеивается без разметки."""
    shared = '<?xml version="1.0"?><sst><si><r><t>Пери</t></r><r><t>од</t></r></si></sst>'
    book = _build(
        tmp_path,
        {"Data": _sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')},
        shared=shared,
    )
    assert XlsxFile.open(book).read_ranges(_refs("Data!A1"))[0].value == "Период"


def test_xml_entities_are_decoded_and_spaces_kept(tmp_path: Path) -> None:
    """Проверяет: &#x41F; раскрывается в букву, ведущие пробелы не тримятся."""
    shared = '<?xml version="1.0"?><sst><si><t xml:space="preserve"> &#x41F;&amp;A </t></si></sst>'
    book = _build(
        tmp_path,
        {"Data": _sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')},
        shared=shared,
    )
    assert XlsxFile.open(book).read_ranges(_refs("Data!A1"))[0].value == " П&A "


def test_cells_without_r_attribute_are_indexed_implicitly(tmp_path: Path) -> None:
    """Проверяет: строки/ячейки без `r` нумеруются последовательно (кривые выгрузки)."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row><c t="str"><v>a</v></c><c t="str"><v>b</v></c></row>'
                '<row><c t="str"><v>c</v></c></row>'
            )
        },
    )
    cells = XlsxFile.open(book).read_ranges(_refs("Data!A1:B2"))
    assert [(c.range, c.value) for c in cells] == [
        ("Data!A1", "a"),
        ("Data!B1", "b"),
        ("Data!A2", "c"),
        ("Data!B2", None),
    ]


def test_merged_area_repeats_anchor_value(tmp_path: Path) -> None:
    """Проверяет: объединённая шапка отдаёт значение во всех своих ячейках."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1" t="str"><v>Отчёт</v></c></row>',
                merges="A1:B2",
            )
        },
    )
    cells = XlsxFile.open(book).read_ranges(_refs("Data!A1:B2"))
    assert [c.value for c in cells] == ["Отчёт"] * 4


# ────────────────────────────────────────────────────────────────────────────
# Диапазоны
# ────────────────────────────────────────────────────────────────────────────


def test_open_ended_ranges_are_clamped_to_sheet_size(tmp_path: Path) -> None:
    """Проверяет: `A:A`, `1:1` и голое имя листа ограничиваются реальными размерами."""
    book = _build(
        tmp_path,
        {
            "Data": _sheet(
                '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>'
                '<row r="2"><c r="A2"><v>3</v></c></row>'
            )
        },
    )
    f = XlsxFile.open(book)
    assert [c.range for c in f.read_ranges(_refs("Data!A:A"))] == ["Data!A1", "Data!A2"]
    assert [c.range for c in f.read_ranges(_refs("Data!1:1"))] == ["Data!A1", "Data!B1"]
    assert len(f.read_ranges(_refs("Data"))) == 4


def test_reversed_range_is_normalised(tmp_path: Path) -> None:
    """Проверяет: `B2:A1` читается как `A1:B2`."""
    book = _build(tmp_path, {"Data": _sheet('<row r="1"><c r="A1"><v>1</v></c></row>')})
    cells = XlsxFile.open(book).read_ranges(_refs("Data!B2:A1"))
    assert [c.range for c in cells] == ["Data!A1", "Data!B1", "Data!A2", "Data!B2"]
