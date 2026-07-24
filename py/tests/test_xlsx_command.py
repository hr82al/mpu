"""Тесты CLI `mpu xlsx` (mpu.commands.xlsx).

Драйвим subcommand'ы через `typer.testing.CliRunner`, мокаем именованные швы:
  - `store.DB_PATH` → tmp sqlite (bootstrap через фикстуру `bootstrap_db`);
  - `env._loaded` + `MPU_XLSX` — изоляция от реального окружения;
  - `subprocess.Popen` — для `open` (ничего не запускаем).

Файлы-фикстуры собираются `zipfile` (см. tests/test_xlsx_reader.py) — сети нет
и не должно быть: команда работает только с локальным диском.
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mpu.commands import xlsx as xlsx_cmd
from mpu.lib import env, store

runner = CliRunner()


@pytest.fixture
def db(
    tmp_path: Path,
    bootstrap_db: Callable[[Path | str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Path]:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("MPU_XLSX", raising=False)
    path = tmp_path / "mpu.db"
    bootstrap_db(path)
    monkeypatch.setattr(store, "DB_PATH", path)
    yield path


@pytest.fixture
def book(tmp_path: Path) -> Path:
    """Книга из двух листов: Data (значения + формула) и Пустой."""
    path = tmp_path / "report.xlsx"
    rels_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "xl/workbook.xml",
            f'<workbook xmlns:r="{rels_ns}"><sheets>'
            '<sheet name="Data" sheetId="1" r:id="rId1"/>'
            '<sheet name="Пустой" sheetId="2" r:id="rId2"/>'
            "</sheets></workbook>",
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData>"
            '<row r="1"><c r="A1" t="str"><v>Период: 01.04.2026</v></c>'
            '<c r="B1"><v>5</v></c></row>'
            '<row r="2"><c r="B2"><f>B1*2</f><v>10</v></c></row>'
            "</sheetData></worksheet>",
        )
        zf.writestr("xl/worksheets/sheet2.xml", "<worksheet><sheetData/></worksheet>")
    return path


# ────────────────────────────────────────────────────────────────────────────
# ls
# ────────────────────────────────────────────────────────────────────────────


def test_ls_prints_one_title_per_line(db: Path, book: Path) -> None:
    """Проверяет: дефолтный ls — имена листов построчно."""
    result = runner.invoke(xlsx_cmd.app, ["ls", "-f", str(book)])
    assert result.exit_code == 0
    assert result.stdout == "Data\nПустой\n"


def test_ls_long_aligns_by_code_points(db: Path, book: Path) -> None:
    """Проверяет: -l выравнивает колонки по длине имени, включая кириллицу."""
    result = runner.invoke(xlsx_cmd.app, ["ls", "-f", str(book), "-l"])
    assert result.stdout == "Data    2×2  #0\nПустой  0×0  #1\n"


def test_ls_json_is_structured(db: Path, book: Path) -> None:
    """Проверяет: --json отдаёт массив объектов с размерами."""
    result = runner.invoke(xlsx_cmd.app, ["ls", "-f", str(book), "--json"])
    assert json.loads(result.stdout) == [
        {"title": "Data", "index": 0, "rows": 2, "cols": 2},
        {"title": "Пустой", "index": 1, "rows": 0, "cols": 0},
    ]


def test_ls_rejects_long_with_json(db: Path, book: Path) -> None:
    """Проверяет: -l и --json взаимоисключающие."""
    result = runner.invoke(xlsx_cmd.app, ["ls", "-f", str(book), "-l", "--json"])
    assert result.exit_code == 2
    assert "only one of --long / --json" in result.output


# ────────────────────────────────────────────────────────────────────────────
# get — форматы
# ────────────────────────────────────────────────────────────────────────────


def test_get_json_omits_formula_when_absent(db: Path, book: Path) -> None:
    """Проверяет: ключ formula есть только у реальных формул; file — абсолютный путь."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A1:B2"])
    payload = json.loads(result.stdout)
    assert payload["file"] == str(book)
    assert payload["cells"] == [
        {"range": "Data!A1", "value": "Период: 01.04.2026"},
        {"range": "Data!B1", "value": 5},
        {"range": "Data!A2", "value": None},
        {"range": "Data!B2", "value": 10, "formula": "=B1*2"},
    ]


def test_get_tsv_has_header_and_escapes(db: Path, book: Path) -> None:
    """Проверяет: TSV с шапкой; переводы строк в значении экранируются литерально."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A1:B1", "--tsv"])
    assert result.stdout == ("range\tvalue\tformula\nData!A1\tПериод: 01.04.2026\t\nData!B1\t5\t\n")


def test_get_raw_single_cell_has_no_trailing_newline(db: Path, book: Path) -> None:
    """Проверяет: одна ячейка в --raw печатается голым значением без \\n."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A1", "--raw"])
    assert result.stdout == "Период: 01.04.2026"


def test_get_render_modes_select_columns(db: Path, book: Path) -> None:
    """Проверяет: --render values|formulas оставляет только свою колонку."""
    values = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!B2", "--render", "values"])
    assert json.loads(values.stdout)["cells"] == [{"range": "Data!B2", "value": 10}]

    formulas = runner.invoke(
        xlsx_cmd.app, ["get", "-f", str(book), "Data!B2", "--render", "formulas"]
    )
    assert json.loads(formulas.stdout)["cells"] == [{"range": "Data!B2", "formula": "=B1*2"}]


def test_get_rejects_unknown_render(db: Path, book: Path) -> None:
    """Проверяет: неизвестный --render → код 2 и перечень допустимых."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A1", "--render", "nope"])
    assert result.exit_code == 2
    assert "both | values | formulas" in result.output


def test_get_rejects_two_formats(db: Path, book: Path) -> None:
    """Проверяет: --raw вместе с --tsv отвергается."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A1", "--raw", "--tsv"])
    assert result.exit_code == 2
    assert "only one of --json / --raw / --tsv" in result.output


# ────────────────────────────────────────────────────────────────────────────
# get — источники диапазонов
# ────────────────────────────────────────────────────────────────────────────


def test_sheet_option_prefixes_bare_ranges(db: Path, book: Path) -> None:
    """Проверяет: --sheet подставляется только в диапазоны без `!`."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "-n", "Data", "A1", "B1"])
    assert [c["range"] for c in json.loads(result.stdout)["cells"]] == ["Data!A1", "Data!B1"]


def test_bare_range_without_sheet_is_rejected(db: Path, book: Path) -> None:
    """Проверяет: диапазон без префикса и без --sheet → понятная ошибка, код 2."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "A1"])
    assert result.exit_code == 2
    assert "--sheet" in result.output


def test_ranges_from_stdin_with_comments(db: Path, book: Path) -> None:
    """Проверяет: --from - читает диапазоны из stdin, `#` и пустые строки пропускаются."""
    result = runner.invoke(
        xlsx_cmd.app,
        ["get", "-f", str(book), "--from", "-"],
        input="# комментарий\n\nData!A1\n",
    )
    assert [c["range"] for c in json.loads(result.stdout)["cells"]] == ["Data!A1"]


def test_duplicate_ranges_are_deduped(db: Path, book: Path) -> None:
    """Проверяет: повторный диапазон читается один раз, порядок сохраняется."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!B1", "Data!A1", "Data!B1"])
    assert [c["range"] for c in json.loads(result.stdout)["cells"]] == ["Data!B1", "Data!A1"]


def test_no_ranges_at_all_is_rejected(db: Path, book: Path) -> None:
    """Проверяет: вызов без диапазонов → код 2 с подсказкой по использованию."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book)])
    assert result.exit_code == 2
    assert "no ranges provided" in result.output


def test_open_ended_range_is_clamped(db: Path, book: Path) -> None:
    """Проверяет: `Data!A:A` ограничивается фактическим числом строк."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Data!A:A"])
    assert [c["range"] for c in json.loads(result.stdout)["cells"]] == ["Data!A1", "Data!A2"]


def test_unknown_sheet_reports_available(db: Path, book: Path) -> None:
    """Проверяет: несуществующий лист → код 1 и список доступных листов."""
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(book), "Nope!A1"])
    assert result.exit_code == 1
    assert "Available: Data, Пустой" in result.output


def test_broken_file_reports_clean_error(db: Path, tmp_path: Path) -> None:
    """Проверяет: не-zip файл → внятная ошибка, а не traceback."""
    junk = tmp_path / "junk.xlsx"
    junk.write_text("not a zip")
    result = runner.invoke(xlsx_cmd.app, ["get", "-f", str(junk), "S!A1"])
    assert result.exit_code == 1
    assert "not a valid xlsx file" in result.output


# ────────────────────────────────────────────────────────────────────────────
# resolve / open
# ────────────────────────────────────────────────────────────────────────────


def test_resolve_human_lists_all_sources(db: Path, book: Path) -> None:
    """Проверяет: человекочитаемый resolve помечает `*` использованный источник."""
    result = runner.invoke(xlsx_cmd.app, ["resolve", "-f", str(book)])
    assert result.exit_code == 0
    assert result.stdout.startswith(f"{book}  (source: --file/-f)")
    assert "* --file/-f" in result.stdout
    assert "env MPU_XLSX              (unset)" in result.stdout


def test_resolve_json_when_nothing_set(db: Path) -> None:
    """Проверяет: без источников --json отдаёт resolved: null и код 0."""
    result = runner.invoke(xlsx_cmd.app, ["resolve", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["resolved"] is None
    assert [e["used"] for e in payload["checked"]] == [False, False, False]


def test_resolve_human_when_nothing_set_fails(db: Path) -> None:
    """Проверяет: без источников человекочитаемый resolve — ошибка с кодом 2."""
    result = runner.invoke(xlsx_cmd.app, ["resolve"])
    assert result.exit_code == 2
    assert "(unset)" in result.output


def _spy_popen(calls: list[list[str]]) -> Callable[..., None]:
    """Заглушка `subprocess.Popen`: записывает argv, ничего не запускает."""

    def _popen(cmd: list[str], **_kwargs: object) -> None:
        calls.append(cmd)

    return _popen


def test_open_print_does_not_launch(db: Path, book: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Проверяет: --print печатает путь и ничего не запускает."""
    calls: list[list[str]] = []
    monkeypatch.setattr(xlsx_cmd.subprocess, "Popen", _spy_popen(calls))
    result = runner.invoke(xlsx_cmd.app, ["open", "-f", str(book), "--print"])
    assert result.stdout.strip() == str(book)
    assert calls == []


def test_open_launches_system_opener(db: Path, book: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Проверяет: без --print вызывается системный опенер с резолвленным путём."""
    calls: list[list[str]] = []

    def _which(_name: str) -> str:
        return "/usr/bin/xdg-open"

    monkeypatch.setattr(xlsx_cmd.shutil, "which", _which)
    monkeypatch.setattr(xlsx_cmd.subprocess, "Popen", _spy_popen(calls))
    runner.invoke(xlsx_cmd.app, ["open", "-f", str(book)])
    assert calls == [["/usr/bin/xdg-open", str(book)]]


# ────────────────────────────────────────────────────────────────────────────
# alias
# ────────────────────────────────────────────────────────────────────────────


def test_alias_roundtrip_through_cli(db: Path, book: Path) -> None:
    """Проверяет: add → используется как -f → ls показывает → rm удаляет."""
    added = runner.invoke(xlsx_cmd.app, ["alias", "add", "report", str(book)])
    assert added.stdout.strip() == f"alias report → {book}"

    used = runner.invoke(xlsx_cmd.app, ["ls", "-f", "report"])
    assert used.stdout == "Data\nПустой\n"

    listed = runner.invoke(xlsx_cmd.app, ["alias", "ls", "--json"])
    assert [a["name"] for a in json.loads(listed.stdout)] == ["report"]

    removed = runner.invoke(xlsx_cmd.app, ["alias", "rm", "report"])
    assert removed.stdout.strip() == "removed report"
    assert json.loads(runner.invoke(xlsx_cmd.app, ["alias", "ls", "--json"]).stdout) == []


def test_alias_ls_empty_hints_how_to_add(db: Path) -> None:
    """Проверяет: пустой список алиасов подсказывает команду добавления."""
    result = runner.invoke(xlsx_cmd.app, ["alias", "ls"])
    assert "no aliases configured" in result.stdout


def test_alias_add_rejects_name_with_space(db: Path, book: Path) -> None:
    """Проверяет: имя с пробелом отвергается с кодом 2."""
    result = runner.invoke(xlsx_cmd.app, ["alias", "add", "my report", str(book)])
    assert result.exit_code == 2
    assert "невалидное имя алиаса" in result.output


def test_alias_rm_missing_is_idempotent(db: Path) -> None:
    """Проверяет: удаление несуществующего алиаса — не ошибка (идемпотентность)."""
    result = runner.invoke(xlsx_cmd.app, ["alias", "rm", "ghost"])
    assert result.exit_code == 0
