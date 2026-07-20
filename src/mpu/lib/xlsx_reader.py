"""Ридер локальных `.xlsx` (OOXML) на stdlib — `zipfile` + `xml.etree`.

Читает ровно то, что нужно `mpu xlsx`: имена листов, размеры, значения и
формулы ячеек. Ни записи, ни кэша — каждый `open()` читает файл с диска.

Разбираются 4 сущности zip-архива: `xl/workbook.xml` (список листов),
`xl/_rels/workbook.xml.rels` (r:id → путь листа), `xl/sharedStrings.xml`
(таблица строк) и сами `xl/worksheets/sheetN.xml`.

Нюансы формата, которые здесь учтены:
    - implicit-индексация: строки/ячейки без атрибута `r` нумеруются
      последовательно (встречается в выгрузках маркетплейсов);
    - sharedStrings с rich text (`<si><r><t>`) склеиваются, форматирование ранов
      отбрасывается;
    - формула отдаётся вместе с закэшированным в `<v>` значением; shared/array
      формулы НЕ разворачиваются — у ячеек-последователей `<f>` пуст;
    - `<mergeCells>`: значение верхней левой ячейки размножается на всю область;
    - тип `e` (`#DIV/0!`, `#REF!`) отдаётся текстом ошибки, а не пустотой.

НЕ разбираются (осознанно): `styles.xml` → даты остаются серийными числами
Excel, форматирование недоступно; defined names, гиперссылки, комментарии.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from mpu.lib.sheet_cache import RangeRef, col_letters_to_num, col_num_to_letters

__all__ = ["Cell", "SheetSummary", "XlsxError", "XlsxFile"]

_WORKBOOK_PATH = "xl/workbook.xml"
_RELS_PATH = "xl/_rels/workbook.xml.rels"
_SHARED_STRINGS_PATH = "xl/sharedStrings.xml"
_REL_ID_ATTR = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


class XlsxError(Exception):
    """Файл не читается как .xlsx, либо запрошен несуществующий лист."""


@dataclass(frozen=True)
class SheetSummary:
    title: str
    index: int
    rows: int
    cols: int


@dataclass(frozen=True)
class Cell:
    range: str
    value: object | None
    formula: str | None = None


@dataclass(frozen=True)
class _SheetEntry:
    name: str
    zip_path: str


@dataclass(frozen=True)
class _CellValue:
    value: object | None
    formula: str | None


@dataclass(frozen=True)
class _ParsedSheet:
    cells: dict[tuple[int, int], _CellValue]
    max_row: int
    max_col: int


# ────────────────────────────────────────────────────────────────────────────
# XML helpers
# ────────────────────────────────────────────────────────────────────────────


def _local(tag: str) -> str:
    """Имя элемента без namespace: `{...}sheetData` → `sheetData`."""
    return tag.rsplit("}", 1)[-1]


def _find(parent: ET.Element, name: str) -> ET.Element | None:
    for child in parent:
        if _local(child.tag) == name:
            return child
    return None


def _iter(parent: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in parent if _local(child.tag) == name]


def _text(elem: ET.Element | None) -> str:
    """Текст элемента вместе с текстом вложенных узлов (`<t>` внутри `<is>`)."""
    if elem is None:
        return ""
    return "".join(elem.itertext())


def _shared_string_item(si: ET.Element) -> str:
    """`<si>` = либо `<t>`, либо последовательность ранов `<r><t>`."""
    t = _find(si, "t")
    if t is not None:
        return _text(t)
    return "".join(_text(_find(run, "t")) for run in _iter(si, "r"))


def _parse_shared_strings(xml: bytes) -> list[str]:
    root = ET.fromstring(xml)
    return [_shared_string_item(si) for si in _iter(root, "si")]


def _parse_rels(xml: bytes) -> dict[str, str]:
    root = ET.fromstring(xml)
    rels: dict[str, str] = {}
    for rel in _iter(root, "Relationship"):
        rel_id, target = rel.get("Id"), rel.get("Target")
        if rel_id and target:
            rels[rel_id] = target
    return rels


def _zip_path_for(target: str) -> str:
    """Target из rels → путь внутри архива (ведущий `/` = уже абсолютный)."""
    if target.startswith("/"):
        return target[1:]
    return "xl/" + target.removeprefix("./")


def _parse_workbook(xml: bytes, rels: dict[str, str]) -> list[_SheetEntry]:
    root = ET.fromstring(xml)
    sheets_elem = _find(root, "sheets")
    if sheets_elem is None:
        return []
    entries: list[_SheetEntry] = []
    for sheet in _iter(sheets_elem, "sheet"):
        target = rels.get(sheet.get(_REL_ID_ATTR, ""), "")
        if not target:
            continue
        entries.append(_SheetEntry(name=sheet.get("name", ""), zip_path=_zip_path_for(target)))
    return entries


# ────────────────────────────────────────────────────────────────────────────
# Ячейки
# ────────────────────────────────────────────────────────────────────────────


def _parse_address(addr: str | None, row: int, fallback_col: int) -> tuple[int, int]:
    """`B7` → (7, 2). Без атрибута `r` — implicit-позиция."""
    if addr:
        letters = "".join(ch for ch in addr if ch.isalpha())
        digits = "".join(ch for ch in addr if ch.isdigit())
        if letters and digits and letters + digits == addr:
            return int(digits), col_letters_to_num(letters)
    return row, fallback_col


def _decode_number(raw: str) -> object:
    """Числовой тип по умолчанию; нечисловое остаётся строкой (как в OOXML-дикой природе)."""
    try:
        num = float(raw)
    except ValueError:
        return raw
    return int(num) if num.is_integer() else num


def _decode_cell(c: ET.Element, shared: list[str]) -> _CellValue:
    f = _find(c, "f")
    formula_raw = _text(f) if f is not None else ""
    formula = None
    if formula_raw:
        formula = formula_raw if formula_raw.startswith("=") else "=" + formula_raw

    cell_type = c.get("t", "n")
    raw = _text(_find(c, "v"))
    value: object | None

    if cell_type == "s":
        try:
            idx = int(raw)
        except ValueError:
            value = None
        else:
            value = shared[idx] if 0 <= idx < len(shared) else None
    elif cell_type == "inlineStr":
        inline = _find(c, "is")
        value = (_shared_string_item(inline) if inline is not None else "") or None
    elif cell_type == "str":
        value = raw or None
    elif cell_type == "b":
        value = raw == "1"
    elif cell_type == "e":
        # Отличие от прежней реализации: текст ошибки не теряется.
        value = raw or None
    else:
        value = _decode_number(raw) if raw else None

    return _CellValue(value=value, formula=formula)


def _parse_merges(root: ET.Element, cells: dict[tuple[int, int], _CellValue]) -> None:
    """Размножить значение верхней левой ячейки на всю объединённую область."""
    merge_cells = _find(root, "mergeCells")
    if merge_cells is None:
        return
    for merge in _iter(merge_cells, "mergeCell"):
        ref = merge.get("ref", "")
        if ":" not in ref:
            continue
        left, right = ref.split(":", 1)
        try:
            r1, c1 = _parse_address_strict(left)
            r2, c2 = _parse_address_strict(right)
        except ValueError:
            continue
        anchor = cells.get((min(r1, r2), min(c1, c2)))
        if anchor is None:
            continue
        for row in range(min(r1, r2), max(r1, r2) + 1):
            for col in range(min(c1, c2), max(c1, c2) + 1):
                cells.setdefault((row, col), _CellValue(value=anchor.value, formula=None))


def _parse_address_strict(addr: str) -> tuple[int, int]:
    letters = "".join(ch for ch in addr if ch.isalpha())
    digits = "".join(ch for ch in addr if ch.isdigit())
    if not letters or not digits or letters + digits != addr:
        raise ValueError(f"Invalid cell address: '{addr}'")
    return int(digits), col_letters_to_num(letters)


def _parse_sheet(xml: bytes, shared: list[str]) -> _ParsedSheet:
    root = ET.fromstring(xml)
    sheet_data = _find(root, "sheetData")
    cells: dict[tuple[int, int], _CellValue] = {}
    max_row = 0
    max_col = 0

    if sheet_data is not None:
        implicit_row = 0
        for row_elem in _iter(sheet_data, "row"):
            implicit_row += 1
            row_attr = row_elem.get("r")
            row = int(row_attr) if row_attr and row_attr.isdigit() else implicit_row
            implicit_row = row
            implicit_col = 0
            for c in _iter(row_elem, "c"):
                implicit_col += 1
                cell_row, cell_col = _parse_address(c.get("r"), row, implicit_col)
                implicit_col = cell_col
                decoded = _decode_cell(c, shared)
                if decoded.value is not None or decoded.formula is not None:
                    cells[(cell_row, cell_col)] = decoded
                max_row = max(max_row, cell_row)
                max_col = max(max_col, cell_col)

    _parse_merges(root, cells)
    for cell_row, cell_col in cells:
        max_row = max(max_row, cell_row)
        max_col = max(max_col, cell_col)

    return _ParsedSheet(cells=cells, max_row=max_row, max_col=max_col)


# ────────────────────────────────────────────────────────────────────────────
# Файл
# ────────────────────────────────────────────────────────────────────────────


class XlsxFile:
    """Открытая книга: список листов + разобранные ячейки."""

    def __init__(self, sheets: list[_SheetEntry], parsed: dict[str, _ParsedSheet]) -> None:
        self._sheets = sheets
        self._parsed = parsed

    @classmethod
    def open(cls, path: Path | str) -> XlsxFile:
        target = Path(path)
        try:
            with zipfile.ZipFile(target) as zf:
                return cls._from_zip(zf, target)
        except FileNotFoundError as e:
            raise XlsxError(f'file not found: "{target}"') from e
        except zipfile.BadZipFile as e:
            raise XlsxError(f'not a valid xlsx file: "{target}" (not a zip archive)') from e
        except ET.ParseError as e:
            raise XlsxError(f'not a valid xlsx file: "{target}" (malformed XML: {e})') from e

    @classmethod
    def _from_zip(cls, zf: zipfile.ZipFile, target: Path) -> XlsxFile:
        names = set(zf.namelist())

        def read(name: str) -> bytes | None:
            return zf.read(name) if name in names else None

        workbook_xml = read(_WORKBOOK_PATH)
        if workbook_xml is None:
            raise XlsxError(f'not a valid xlsx file: "{target}" (missing {_WORKBOOK_PATH})')

        rels_xml = read(_RELS_PATH)
        rels = _parse_rels(rels_xml) if rels_xml else {}
        shared_xml = read(_SHARED_STRINGS_PATH)
        shared = _parse_shared_strings(shared_xml) if shared_xml else []
        sheets = _parse_workbook(workbook_xml, rels)

        parsed: dict[str, _ParsedSheet] = {}
        for entry in sheets:
            sheet_xml = read(entry.zip_path)
            if sheet_xml is not None:
                parsed[entry.zip_path] = _parse_sheet(sheet_xml, shared)
        return cls(sheets, parsed)

    def list_sheets(self) -> list[SheetSummary]:
        out: list[SheetSummary] = []
        for index, entry in enumerate(self._sheets):
            parsed = self._parsed.get(entry.zip_path)
            out.append(
                SheetSummary(
                    title=entry.name,
                    index=index,
                    rows=parsed.max_row if parsed else 0,
                    cols=parsed.max_col if parsed else 0,
                )
            )
        return out

    def read_ranges(self, refs: list[RangeRef]) -> list[Cell]:
        """Плоский dense-список ячеек row-major, включая пустые (`value=None`)."""
        cells: list[Cell] = []
        for ref in refs:
            parsed = self._parsed_for(ref.tab)
            if parsed is None:
                continue
            row1, col1, row2, col2 = _clamp(ref, parsed)
            for row in range(row1, row2 + 1):
                for col in range(col1, col2 + 1):
                    a1 = f"{ref.tab}!{col_num_to_letters(col)}{row}"
                    found = parsed.cells.get((row, col))
                    if found is None:
                        cells.append(Cell(range=a1, value=None))
                    else:
                        cells.append(Cell(range=a1, value=found.value, formula=found.formula))
        return cells

    def _parsed_for(self, tab: str) -> _ParsedSheet | None:
        for entry in self._sheets:
            if entry.name == tab:
                return self._parsed.get(entry.zip_path)
        titles = ", ".join(s.name for s in self._sheets)
        raise XlsxError(f'sheet "{tab}" not found. Available: {titles}')


def _span(lo: int | None, hi: int | None, sheet_max: int) -> tuple[int, int]:
    """Границы одной оси. Обе None (`A:A`) — весь лист; одна None — до конца листа."""
    present = [v for v in (lo, hi) if v is not None]
    if not present:
        return 1, sheet_max
    if len(present) == 1:
        return present[0], max(present[0], sheet_max)
    return min(present), max(present)


def _clamp(ref: RangeRef, parsed: _ParsedSheet) -> tuple[int, int, int, int]:
    """Открытые границы (`A:A`, `1:5`, весь лист) → фактические размеры листа."""
    row1, row2 = _span(ref.row1, ref.row2, parsed.max_row)
    col1, col2 = _span(ref.col1, ref.col2, parsed.max_col)
    return row1, col1, row2, col2
