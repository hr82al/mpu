"""Тесты `lib/sheet_batch.py` — мини-язык → Sheets `requests[]` / `ReadPlan`."""

from __future__ import annotations

from typing import Any

import pytest

from mpu.lib.sheet_batch import (
    BatchScriptError,
    coerce_value,
    collect_sheet_ids,
    compile_read,
    compile_update,
    hex_to_rgb,
    parse_style_flags,
    parse_update_script,
    range_ref_to_gridrange,
    split_statements,
    to_dimension_range,
    tokenize,
    unquote,
)
from mpu.lib.sheet_cache import parse_range

META = {"Чек-лист": 615730406, "План сезона": 111, "rnp_tech": 5, "S": 9}


def cu(script: str, **kw: Any) -> list[dict[str, Any]]:
    return compile_update(parse_update_script(script), META, **kw)


# ── лексер ───────────────────────────────────────────────────────────────────


def test_split_statements_semicolon_and_newline() -> None:
    assert split_statements("a 1; b 2\n c 3") == ["a 1", "b 2", "c 3"]


def test_split_statements_keeps_formula_semicolons_inside_parens() -> None:
    # `;` внутри `(…)` — часть формулы, не разделитель statement'ов.
    assert split_statements("set A1 = =LET(a;1;b;2)") == ["set A1 = =LET(a;1;b;2)"]


def test_split_statements_hash_is_comment_only_at_token_boundary() -> None:
    # `#` после пробела — комментарий; `#` в hex-цвете — литерал.
    assert split_statements("label A1 'x' bg=#EA4335  # коммент") == ["label A1 'x' bg=#EA4335"]
    assert split_statements("# whole line\nmerge A1:B1") == ["merge A1:B1"]


def test_split_statements_brace_block_multiline() -> None:
    assert split_statements('@x {\n "a": 1;\n "b": 2\n}') == ['@x {\n "a": 1;\n "b": 2\n}']


def test_tokenize_quotes_protect_spaces_and_keep_range_quotes() -> None:
    assert tokenize("label 'Чек-лист'!H1 \"Длинный текст\" bold") == [
        "label",
        "'Чек-лист'!H1",
        '"Длинный текст"',
        "bold",
    ]


def test_tokenize_brace_block_single_token() -> None:
    assert tokenize('@k {"a": {"b": 1}}') == ["@k", '{"a": {"b": 1}}']


def test_unquote() -> None:
    assert unquote('"abc"') == "abc"
    assert unquote("'a b'") == "a b"
    assert unquote("bare") == "bare"
    assert unquote(r"'a\'b'") == "a'b"


# ── цвет / значения ──────────────────────────────────────────────────────────


def test_hex_to_rgb() -> None:
    assert hex_to_rgb("#fff") == {"red": 1.0, "green": 1.0, "blue": 1.0}
    assert hex_to_rgb("#000000") == {"red": 0.0, "green": 0.0, "blue": 0.0}
    assert "alpha" in hex_to_rgb("#80ffffff")
    with pytest.raises(BatchScriptError):
        hex_to_rgb("#xyz")


def test_coerce_value() -> None:
    assert coerce_value("=A1", quoted=False, literal=False) == {"formulaValue": "=A1"}
    assert coerce_value("42", quoted=False, literal=False) == {"numberValue": 42.0}
    assert coerce_value("true", quoted=False, literal=False) == {"boolValue": True}
    assert coerce_value("txt", quoted=False, literal=False) == {"stringValue": "txt"}
    assert coerce_value("=A1", quoted=True, literal=False) == {"stringValue": "=A1"}
    assert coerce_value("42", quoted=False, literal=True) == {"stringValue": "42"}


# ── диапазоны ────────────────────────────────────────────────────────────────


def test_range_ref_to_gridrange_open_and_closed() -> None:
    assert range_ref_to_gridrange(parse_range("'T'!H2:J10"), 7) == {
        "sheetId": 7,
        "startRowIndex": 1,
        "endRowIndex": 10,
        "startColumnIndex": 7,
        "endColumnIndex": 10,
    }
    # открытый столбец H:H → нет границ по строкам.
    assert range_ref_to_gridrange(parse_range("'T'!H:H"), 7) == {
        "sheetId": 7,
        "startColumnIndex": 7,
        "endColumnIndex": 8,
    }


def test_to_dimension_range_letters_or_numbers() -> None:
    # буквы H ≡ номер 8 → один и тот же индекс.
    by_letter = to_dimension_range("H", "COLUMNS", META, "rnp_tech")
    by_number = to_dimension_range("8", "COLUMNS", META, "rnp_tech")
    assert (
        by_letter
        == by_number
        == {"sheetId": 5, "dimension": "COLUMNS", "startIndex": 7, "endIndex": 8}
    )
    assert to_dimension_range("H:J", "COLUMNS", META, "rnp_tech")["endIndex"] == 10


def test_unknown_tab_raises() -> None:
    with pytest.raises(BatchScriptError):
        cu("merge 'Нет такого'!A1:B1")


# ── стиль ────────────────────────────────────────────────────────────────────


def test_parse_style_flags() -> None:
    fmt, fields = parse_style_flags(["bold", "bg=#000000", "center", 'fmt="0.00%"'])
    assert fmt["textFormat"] == {"bold": True}
    assert fmt["backgroundColor"] == {"red": 0.0, "green": 0.0, "blue": 0.0}
    assert fmt["horizontalAlignment"] == "CENTER"
    assert fmt["numberFormat"] == {"type": "PERCENT", "pattern": "0.00%"}
    assert "userEnteredFormat.textFormat.bold" in fields

    with pytest.raises(BatchScriptError):
        parse_style_flags(["bogus"])


# ── 1:1 порты reference-скриптов ──────────────────────────────────────────────


def test_port_insert_columns() -> None:
    assert cu("cols insert H +10 inherit=before", default_tab="Чек-лист") == [
        {
            "insertDimension": {
                "range": {
                    "sheetId": 615730406,
                    "dimension": "COLUMNS",
                    "startIndex": 7,
                    "endIndex": 17,
                },
                "inheritFromBefore": True,
            }
        }
    ]


def test_port_delete_columns() -> None:
    assert cu("cols delete M:Q", default_tab="Чек-лист") == [
        {
            "deleteDimension": {
                "range": {
                    "sheetId": 615730406,
                    "dimension": "COLUMNS",
                    "startIndex": 12,
                    "endIndex": 17,
                }
            }
        }
    ]


def test_port_set_formula() -> None:
    reqs = cu("set 'Чек-лист'!M2 = =LET(a;1;a)")
    cell = reqs[0]["updateCells"]
    assert cell["fields"] == "userEnteredValue"
    assert cell["rows"][0]["values"][0]["userEnteredValue"] == {"formulaValue": "=LET(a;1;a)"}
    assert cell["start"] == {"sheetId": 615730406, "rowIndex": 1, "columnIndex": 12}


def test_port_find_replace_regex_word_allsheets() -> None:
    assert cu("find-replace /\\bfoo\\b/ bar formulas allsheets case") == [
        {
            "findReplace": {
                "find": "\\bfoo\\b",
                "replacement": "bar",
                "includeFormulas": True,
                "allSheets": True,
                "matchCase": True,
                "searchByRegex": True,
            }
        }
    ]


def test_port_set_data_validation() -> None:
    reqs = cu("validate 'План сезона'!AJ18:AJ81 num>=0 strict msg='≥0'")
    dv = reqs[0]["setDataValidation"]
    assert dv["range"] == {
        "sheetId": 111,
        "startRowIndex": 17,
        "endRowIndex": 81,
        "startColumnIndex": 35,
        "endColumnIndex": 36,
    }
    assert dv["rule"]["condition"] == {
        "type": "NUMBER_GREATER_THAN_EQ",
        "values": [{"userEnteredValue": "0"}],
    }
    assert dv["rule"]["strict"] is True
    assert dv["rule"]["inputMessage"] == "≥0"


# ── прочие глаголы ────────────────────────────────────────────────────────────


def test_label_value_and_format() -> None:
    reqs = cu("label H1 'Заголовок' bg=#EA4335 bold", default_tab="Чек-лист")
    uc = reqs[0]["updateCells"]
    assert uc["rows"][0]["values"][0]["userEnteredValue"] == {"stringValue": "Заголовок"}
    assert "backgroundColor" in uc["rows"][0]["values"][0]["userEnteredFormat"]
    assert uc["fields"].startswith("userEnteredValue,")


def test_cond_add_custom_formula_keeps_inner_quotes() -> None:
    reqs = cu('cond add F5:F custom=\'=AND(E5<>"";G5="")\' bg=#EA4335', default_tab="Чек-лист")
    rule = reqs[0]["addConditionalFormatRule"]["rule"]
    assert rule["booleanRule"]["condition"]["type"] == "CUSTOM_FORMULA"
    assert rule["booleanRule"]["condition"]["values"][0]["userEnteredValue"] == '=AND(E5<>"";G5="")'


def test_merge_default_all() -> None:
    assert cu("merge A1:C1", default_tab="Чек-лист")[0]["mergeCells"]["mergeType"] == "MERGE_ALL"


def test_sheet_add_defaults() -> None:
    props = cu('sheet add "Новый"')[0]["addSheet"]["properties"]
    assert props["title"] == "Новый"
    assert props["gridProperties"] == {"rowCount": 1000, "columnCount": 26}


def test_protect_editors() -> None:
    pr = cu("protect 4:4 editors=a@b.com,c@d.com warn", default_tab="Чек-лист")[0][
        "addProtectedRange"
    ]["protectedRange"]
    assert pr["editors"] == {"users": ["a@b.com", "c@d.com"]}
    assert pr["warningOnly"] is True


# ── generic @kind / raw ───────────────────────────────────────────────────────


def test_kind_sugar_resolves_at_tab_and_color() -> None:
    body = (
        '{"range": "@\'Чек-лист\'!A1:B2",'
        ' "cell": {"userEnteredFormat": {"backgroundColor": "#000000"}},'
        ' "fields": "userEnteredFormat"}'
    )
    reqs = cu(f"@repeatCell {body}")
    rc = reqs[0]["repeatCell"]
    assert rc["range"] == {
        "sheetId": 615730406,
        "startRowIndex": 0,
        "endRowIndex": 2,
        "startColumnIndex": 0,
        "endColumnIndex": 2,
    }
    assert rc["cell"]["userEnteredFormat"]["backgroundColor"] == {
        "red": 0.0,
        "green": 0.0,
        "blue": 0.0,
    }


def test_raw_passthrough_verbatim() -> None:
    assert cu('raw {"deleteSheet": {"sheetId": 42}}') == [{"deleteSheet": {"sheetId": 42}}]


def test_unknown_verb_raises_with_line() -> None:
    with pytest.raises(BatchScriptError, match="строка 1"):
        cu("frobnicate A1")


# ── встроенный Python (py-блок) ────────────────────────────────────────────────


def test_py_block_requires_flag() -> None:
    with pytest.raises(BatchScriptError):
        cu("py{ pass }")


def test_py_block_emits_statements_and_requests() -> None:
    def fake_run_py(_body: str) -> tuple[list[str], list[dict[str, Any]]]:
        return (["merge A1:B1"], [{"deleteSheet": {"sheetId": 1}}])

    reqs = cu("py{ ... }", default_tab="S", allow_py=True, run_py=fake_run_py)
    assert reqs[0] == {"deleteSheet": {"sheetId": 1}}
    assert reqs[1]["mergeCells"]["range"]["sheetId"] == 9


# ── collect_sheet_ids ─────────────────────────────────────────────────────────


def test_collect_sheet_ids() -> None:
    reqs = cu("merge A1:B1; cols delete C:D", default_tab="Чек-лист")
    assert collect_sheet_ids(reqs) == {615730406}


# ── чтение ────────────────────────────────────────────────────────────────────


def test_compile_read_values_render_and_dimension() -> None:
    plan = compile_read("get 'Чек-лист'!A1:F formula cols datestr")
    assert plan.values == {
        "ranges": ["'Чек-лист'!A1:F"],
        "majorDimension": "COLUMNS",
        "valueRenderOption": "FORMULA",
        "dateTimeRenderOption": "FORMATTED_STRING",
    }
    assert plan.meta is None


def test_compile_read_sheet_level_aspects() -> None:
    plan = compile_read("read 'Чек-лист' merges cond protected; read named")
    assert plan.meta == {
        "aspects": ["merges", "cond", "protected", "named"],
        "sheets": ["Чек-лист"],
    }


def test_compile_read_default_tab_prefix_quotes_hyphen() -> None:
    plan = compile_read("get H2:H", default_tab="Чек-лист")
    assert plan.values is not None
    assert plan.values["ranges"] == ["'Чек-лист'!H2:H"]


def test_compile_read_percell_aspect_errors() -> None:
    with pytest.raises(BatchScriptError, match="per-cell"):
        compile_read("read 'Чек-лист' formats")


def test_freeze_defaults_to_sheet_flag() -> None:
    # без явного листа берём -n/--sheet; первый токен rows=/cols= не считается листом.
    props = cu("freeze rows=4 cols=7", default_tab="Чек-лист")[0]["updateSheetProperties"]
    assert props["properties"]["sheetId"] == 615730406
    assert props["properties"]["gridProperties"] == {"frozenRowCount": 4, "frozenColumnCount": 7}
    # явный лист тоже работает.
    props2 = cu("freeze 'Чек-лист' rows=1")[0]["updateSheetProperties"]
    assert props2["properties"]["gridProperties"] == {"frozenRowCount": 1}
