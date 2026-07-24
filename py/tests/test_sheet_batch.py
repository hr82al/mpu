"""Тесты `lib/sheet_batch.py` — мини-язык → Sheets `requests[]` / `ReadPlan`."""

from __future__ import annotations

from typing import Any

import pytest

from mpu.lib.sheet_batch import (
    BatchScriptError,
    Stmt,
    coerce_value,
    collect_sheet_ids,
    compile_read,
    compile_update,
    filter_meta,
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


# ── лексер: escape / brace / whitespace edge-cases ────────────────────────────


def test_split_statements_backslash_escape_inside_quotes() -> None:
    # `\` внутри кавычек — экранирование (следующий символ берётся как есть),
    # `;` под кавычками не делит statement'ы.
    assert split_statements(r"set A1 'a\;b'") == [r"set A1 'a\;b'"]


def test_split_statements_trailing_separator_no_empty_stmt() -> None:
    # Хвостовой `;` не должен порождать пустой statement.
    assert split_statements("merge A1:B1;") == ["merge A1:B1"]
    assert split_statements("merge A1:B1;\n   ") == ["merge A1:B1"]


def test_tokenize_whitespace_only_is_empty() -> None:
    assert tokenize("   ") == []
    assert tokenize("") == []


def test_tokenize_unterminated_brace_is_single_token() -> None:
    # `{` без закрывающей `}` — токен до конца строки (loop выходит по концу).
    assert tokenize("@k {unclosed") == ["@k", "{unclosed"]


def test_tokenize_escape_inside_quote_in_brace_block() -> None:
    # `\"` внутри строки внутри `{…}` не закрывает кавычку.
    assert tokenize(r'@k {"a\"b": 1}') == ["@k", r'{"a\"b": 1}']


def test_tokenize_escape_inside_bare_quoted_token() -> None:
    # `\` экранирование в обычном (не-brace) токене.
    assert tokenize(r"set 'a\'b'!A1 = 1") == ["set", r"'a\'b'!A1", "=", "1"]


# ── цвет: проверка длины ──────────────────────────────────────────────────────


def test_hex_to_rgb_bad_length_raises() -> None:
    with pytest.raises(BatchScriptError, match="плохой цвет"):
        hex_to_rgb("#12345")


# ── R1C1 / split-tab / dim-index ──────────────────────────────────────────────


def test_r1c1_single_cell_converts_to_a1() -> None:
    start = cu("set r2c8 = 1", default_tab="Чек-лист")[0]["updateCells"]["start"]
    assert start == {"sheetId": 615730406, "rowIndex": 1, "columnIndex": 7}


def test_to_dimension_range_quoted_and_bare_tab_prefix() -> None:
    quoted = to_dimension_range("'rnp_tech'!H", "COLUMNS", META, None)
    bare = to_dimension_range("rnp_tech!H", "COLUMNS", META, None)
    assert quoted == bare
    assert quoted["sheetId"] == 5


def test_to_dimension_range_no_tab_no_default_raises() -> None:
    with pytest.raises(BatchScriptError, match="нет имени листа"):
        to_dimension_range("H", "COLUMNS", META, None)


def test_to_dimension_range_bad_index_raises() -> None:
    # буква для ROWS (только цифры допустимы) → ошибка.
    with pytest.raises(BatchScriptError, match="плохой индекс"):
        to_dimension_range("H", "ROWS", META, "rnp_tech")
    # вообще не буква/цифра для COLUMNS.
    with pytest.raises(BatchScriptError, match="плохой индекс"):
        to_dimension_range("@", "COLUMNS", META, "rnp_tech")


# ── стиль: все ветки флагов ───────────────────────────────────────────────────


def test_parse_style_flags_all_text_attrs_and_keys() -> None:
    fmt, fields = parse_style_flags(
        [
            "italic",
            "strike",
            "underline",
            "top",
            "fg=#000000",
            "size=12",
            "font=Arial",
        ]
    )
    tf = fmt["textFormat"]
    assert tf["italic"] is True
    assert tf["strikethrough"] is True
    assert tf["underline"] is True
    assert tf["foregroundColor"] == {"red": 0.0, "green": 0.0, "blue": 0.0}
    assert tf["fontSize"] == 12
    assert tf["fontFamily"] == "Arial"
    assert fmt["verticalAlignment"] == "TOP"
    assert "userEnteredFormat.verticalAlignment" in fields


def test_parse_style_flags_dedupes_fields() -> None:
    # Повтор флага не дублирует путь в fields-mask.
    _fmt, fields = parse_style_flags(["bold", "bold"])
    assert fields.count("userEnteredFormat.textFormat.bold") == 1


def test_parse_style_flags_wrap_clip_overflow() -> None:
    for flag, expected in (("wrap", "WRAP"), ("clip", "CLIP"), ("overflow", "OVERFLOW_CELL")):
        fmt, _fields = parse_style_flags([flag])
        assert fmt["wrapStrategy"] == expected


def test_parse_style_flags_fmt_date_and_number() -> None:
    fmt_date, _ = parse_style_flags(['fmt="yyyy-mm-dd"'])
    assert fmt_date["numberFormat"]["type"] == "DATE"
    fmt_num, _ = parse_style_flags(['fmt="0.00"'])
    assert fmt_num["numberFormat"]["type"] == "NUMBER"


# ── generic @kind: sheetId @tab + list-рекурсия ───────────────────────────────


def test_kind_sugar_resolves_sheetid_at_tab() -> None:
    assert cu('@deleteSheet {"sheetId": "@\'Чек-лист\'"}') == [
        {"deleteSheet": {"sheetId": 615730406}}
    ]


def test_kind_sugar_recurses_into_list() -> None:
    reqs = cu(
        '@addConditionalFormatRule {"rule": {"ranges": ["@\'Чек-лист\'!A1:A"],'
        ' "booleanRule": {}}, "index": 0}'
    )
    ranges = reqs[0]["addConditionalFormatRule"]["rule"]["ranges"]
    assert ranges[0]["sheetId"] == 615730406


# ── raw / @kind: ошибки парсинга JSON ─────────────────────────────────────────


def test_raw_bad_json_raises() -> None:
    with pytest.raises(BatchScriptError, match="плохой JSON"):
        cu("raw {not json}")


def test_raw_non_object_json_raises() -> None:
    with pytest.raises(BatchScriptError, match="ожидался JSON-объект"):
        cu("raw [1, 2, 3]")


def test_empty_statement_compiles_to_nothing() -> None:
    # Statement из одних пробелов токенизируется в [] → пустой список requests.
    assert compile_update([Stmt(raw="   ", line=1)], META) == []


# ── set: ветки значения ───────────────────────────────────────────────────────


def test_set_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="set: нужен range"):
        cu("set")


def test_set_value_as_second_arg() -> None:
    reqs = cu("set A1 hello", default_tab="Чек-лист")
    cell = reqs[0]["updateCells"]["rows"][0]["values"][0]["userEnteredValue"]
    assert cell == {"stringValue": "hello"}


def test_set_quoted_second_arg_is_string() -> None:
    reqs = cu("set A1 '42'", default_tab="Чек-лист")
    cell = reqs[0]["updateCells"]["rows"][0]["values"][0]["userEnteredValue"]
    assert cell == {"stringValue": "42"}


def test_set_missing_value_raises() -> None:
    with pytest.raises(BatchScriptError, match="нужно значение"):
        cu("set A1", default_tab="Чек-лист")


def test_set_range_tab_with_backslash() -> None:
    # Имя листа с литеральным `\` резолвится; `_rest_after` пропускает экранированный токен.
    reqs = compile_update(parse_update_script(r"set 'a\b'!A1 = 5"), {r"a\b": 7})
    cell = reqs[0]["updateCells"]
    assert cell["start"]["sheetId"] == 7
    assert cell["rows"][0]["values"][0]["userEnteredValue"] == {"numberValue": 5.0}


# ── label / note / style / clear ──────────────────────────────────────────────


def test_label_requires_range_and_text() -> None:
    with pytest.raises(BatchScriptError, match="label"):
        cu("label A1", default_tab="Чек-лист")


def test_label_without_format_flags() -> None:
    reqs = cu("label A1 'Просто'", default_tab="Чек-лист")
    uc = reqs[0]["updateCells"]
    assert uc["fields"] == "userEnteredValue"
    assert "userEnteredFormat" not in uc["rows"][0]["values"][0]


def test_note_sets_note_field() -> None:
    reqs = cu("note 'Чек-лист'!A1 'примечание'")
    uc = reqs[0]["updateCells"]
    assert uc["fields"] == "note"
    assert uc["rows"][0]["values"][0] == {"note": "примечание"}


def test_note_requires_range_and_text() -> None:
    with pytest.raises(BatchScriptError, match="note"):
        cu("note A1", default_tab="Чек-лист")


def test_style_repeat_cell() -> None:
    reqs = cu("style A1:B2 bold center", default_tab="Чек-лист")
    rc = reqs[0]["repeatCell"]
    assert rc["cell"]["userEnteredFormat"]["textFormat"]["bold"] is True
    assert "userEnteredFormat.horizontalAlignment" in rc["fields"]


def test_style_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="style: нужен range"):
        cu("style")


def test_style_requires_flags() -> None:
    with pytest.raises(BatchScriptError, match="стиль-флаги"):
        cu("style A1", default_tab="Чек-лист")


def test_clear_default_values() -> None:
    reqs = cu("clear A1:B2", default_tab="Чек-лист")
    assert reqs[0]["updateCells"]["fields"] == "userEnteredValue"


def test_clear_all_and_formats() -> None:
    assert (
        cu("clear A1 all", default_tab="Чек-лист")[0]["updateCells"]["fields"]
        == "userEnteredValue,userEnteredFormat,note"
    )
    assert (
        cu("clear A1 formats", default_tab="Чек-лист")[0]["updateCells"]["fields"]
        == "userEnteredFormat"
    )


def test_clear_bad_what_raises() -> None:
    with pytest.raises(BatchScriptError, match="clear: что"):
        cu("clear A1 garbage", default_tab="Чек-лист")


def test_clear_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="clear: нужен range"):
        cu("clear")


# ── insert / delete / move / resize / autosize / hide / show ──────────────────


def test_insert_columns_requires_arg() -> None:
    with pytest.raises(BatchScriptError, match="insert"):
        cu("cols insert", default_tab="Чек-лист")


def test_insert_inherit_after_without_count() -> None:
    reqs = cu("cols insert H inherit=after", default_tab="Чек-лист")
    ins = reqs[0]["insertDimension"]
    assert ins["inheritFromBefore"] is False
    # без +N конечный индекс не расширяется.
    assert ins["range"]["endIndex"] == ins["range"]["startIndex"] + 1


def test_insert_rows_ignores_unknown_flag() -> None:
    reqs = cu("rows insert 5 junk", default_tab="Чек-лист")
    rng = reqs[0]["insertDimension"]["range"]
    assert rng["dimension"] == "ROWS"
    assert rng["startIndex"] == 4


def test_rows_delete() -> None:
    rng = cu("rows delete 2:5", default_tab="Чек-лист")[0]["deleteDimension"]["range"]
    assert rng == {"sheetId": 615730406, "dimension": "ROWS", "startIndex": 1, "endIndex": 5}


def test_cols_move_and_rows_move() -> None:
    cols = cu("cols move B:D after H", default_tab="Чек-лист")[0]["moveDimension"]
    assert cols["source"]["dimension"] == "COLUMNS"
    assert cols["destinationIndex"] == 8
    rows = cu("rows move 2:3 after 10", default_tab="Чек-лист")[0]["moveDimension"]
    assert rows["source"]["dimension"] == "ROWS"
    assert rows["destinationIndex"] == 10


def test_move_bad_syntax_raises() -> None:
    with pytest.raises(BatchScriptError, match="after"):
        cu("cols move B:D", default_tab="Чек-лист")


def test_cols_resize_px() -> None:
    reqs = cu("cols resize H px=120", default_tab="Чек-лист")
    udp = reqs[0]["updateDimensionProperties"]
    assert udp["properties"] == {"pixelSize": 120}
    assert udp["fields"] == "pixelSize"


def test_rows_resize_px() -> None:
    udp = cu("rows resize 1 px=40", default_tab="Чек-лист")[0]["updateDimensionProperties"]
    assert udp["range"]["dimension"] == "ROWS"


def test_resize_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="resize: нужен диапазон"):
        cu("cols resize", default_tab="Чек-лист")


def test_resize_without_px_raises() -> None:
    with pytest.raises(BatchScriptError, match="px=N"):
        cu("cols resize H", default_tab="Чек-лист")


def test_cols_and_rows_autosize() -> None:
    cols = cu("cols autosize H:J", default_tab="Чек-лист")[0]["autoResizeDimensions"]
    assert cols["dimensions"]["dimension"] == "COLUMNS"
    rows = cu("rows autosize 1:5", default_tab="Чек-лист")[0]["autoResizeDimensions"]
    assert rows["dimensions"]["dimension"] == "ROWS"


def test_hide_and_show_cols_rows() -> None:
    assert cu("cols hide H", default_tab="Чек-лист")[0]["updateDimensionProperties"][
        "properties"
    ] == {"hiddenByUser": True}
    assert cu("cols show H", default_tab="Чек-лист")[0]["updateDimensionProperties"][
        "properties"
    ] == {"hiddenByUser": False}
    assert cu("rows hide 2", default_tab="Чек-лист")[0]["updateDimensionProperties"][
        "properties"
    ] == {"hiddenByUser": True}
    assert cu("rows show 2", default_tab="Чек-лист")[0]["updateDimensionProperties"][
        "properties"
    ] == {"hiddenByUser": False}


# ── append ────────────────────────────────────────────────────────────────────


def test_append_rows_on_explicit_sheet() -> None:
    assert cu("append rows 5 on 'Чек-лист'") == [
        {"appendDimension": {"sheetId": 615730406, "dimension": "ROWS", "length": 5}}
    ]


def test_append_cols_default_sheet() -> None:
    assert cu("append cols 3", default_tab="Чек-лист")[0]["appendDimension"]["dimension"] == (
        "COLUMNS"
    )


def test_append_too_few_args_raises() -> None:
    with pytest.raises(BatchScriptError, match="append"):
        cu("append cols", default_tab="Чек-лист")


def test_append_bad_dimension_raises() -> None:
    with pytest.raises(BatchScriptError, match="append: cols"):
        cu("append diagonal 3", default_tab="Чек-лист")


def test_append_without_sheet_raises() -> None:
    with pytest.raises(BatchScriptError, match="нужен лист"):
        cu("append cols 3")


# ── freeze ────────────────────────────────────────────────────────────────────


def test_freeze_without_sheet_raises() -> None:
    with pytest.raises(BatchScriptError, match="freeze: нужен лист"):
        cu("freeze rows=4")


def test_freeze_ignores_unknown_flag() -> None:
    props = cu("freeze 'Чек-лист' rows=1 nonsense")[0]["updateSheetProperties"]
    assert props["properties"]["gridProperties"] == {"frozenRowCount": 1}


def test_freeze_without_flags_raises() -> None:
    with pytest.raises(BatchScriptError, match="rows=N"):
        cu("freeze 'Чек-лист'")


# ── merge / unmerge / border ──────────────────────────────────────────────────


def test_merge_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="merge: нужен range"):
        cu("merge")


def test_merge_rows_type() -> None:
    assert (
        cu("merge A1:C3 rows", default_tab="Чек-лист")[0]["mergeCells"]["mergeType"] == "MERGE_ROWS"
    )


def test_unmerge() -> None:
    assert cu("unmerge A1:B2", default_tab="Чек-лист")[0]["unmergeCells"]["range"]["sheetId"] == (
        615730406
    )


def test_unmerge_requires_arg() -> None:
    with pytest.raises(BatchScriptError, match="нужен аргумент"):
        cu("unmerge")


def test_border_around_with_style_and_color() -> None:
    reqs = cu("border A1:B2 around style=dashed color=#ff0000", default_tab="Чек-лист")
    ub = reqs[0]["updateBorders"]
    assert set(ub) == {"range", "top", "bottom", "left", "right"}
    assert ub["top"] == {"style": "DASHED", "color": {"red": 1.0, "green": 0.0, "blue": 0.0}}


def test_border_default_all_sides() -> None:
    ub = cu("border A1:B2", default_tab="Чек-лист")[0]["updateBorders"]
    assert set(ub) == {
        "range",
        "top",
        "bottom",
        "left",
        "right",
        "innerHorizontal",
        "innerVertical",
    }


def test_border_inner_only() -> None:
    ub = cu("border A1:B2 inner", default_tab="Чек-лист")[0]["updateBorders"]
    assert set(ub) == {"range", "innerHorizontal", "innerVertical"}


def test_border_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="border: нужен range"):
        cu("border")


# ── find-replace ──────────────────────────────────────────────────────────────


def test_find_replace_too_few_args_raises() -> None:
    with pytest.raises(BatchScriptError, match="find-replace"):
        cu("find-replace foo")


def test_find_replace_plain_default_tab_scoped() -> None:
    fr = cu("find-replace foo bar case", default_tab="Чек-лист")[0]["findReplace"]
    assert fr["find"] == "foo"
    assert fr["searchByRegex"] is False
    assert fr["sheetId"] == 615730406
    assert fr["matchCase"] is True


def test_find_replace_no_default_tab_all_sheets() -> None:
    fr = cu("find-replace foo bar")[0]["findReplace"]
    assert fr["allSheets"] is True


def test_find_replace_regex_flag_and_explicit_range() -> None:
    fr = cu("find-replace foo bar regex 'Чек-лист'!A1:B2", default_tab="Чек-лист")[0]["findReplace"]
    assert fr["searchByRegex"] is True
    assert fr["range"]["sheetId"] == 615730406


# ── validate / conditions ─────────────────────────────────────────────────────


def test_validate_requires_range_and_condition() -> None:
    with pytest.raises(BatchScriptError, match="validate"):
        cu("validate A1")


def test_validate_showdrop_and_blank() -> None:
    rule = cu("validate A1 blank showdrop", default_tab="Чек-лист")[0]["setDataValidation"]["rule"]
    assert rule["condition"] == {"type": "BLANK"}
    assert rule["showCustomUi"] is True


def test_condition_one_of_list() -> None:
    cond = cu("validate A1 one-of=a,b,c", default_tab="Чек-лист")[0]["setDataValidation"]["rule"][
        "condition"
    ]
    assert cond["type"] == "ONE_OF_LIST"
    assert [v["userEnteredValue"] for v in cond["values"]] == ["a", "b", "c"]


def test_condition_text_variants() -> None:
    types = {
        "text-contains=x": "TEXT_CONTAINS",
        "text-eq=y": "TEXT_EQ",
        "not-blank": "NOT_BLANK",
        "checkbox": "BOOLEAN",
        "bool": "BOOLEAN",
    }
    for tok, expected in types.items():
        cond = cu(f"validate A1 {tok}", default_tab="Чек-лист")[0]["setDataValidation"]["rule"][
            "condition"
        ]
        assert cond["type"] == expected


def test_condition_bare_formula() -> None:
    cond = cu("validate A1 =A1>5", default_tab="Чек-лист")[0]["setDataValidation"]["rule"][
        "condition"
    ]
    assert cond == {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": "=A1>5"}]}


def test_condition_unknown_raises() -> None:
    with pytest.raises(BatchScriptError, match="непонятное условие"):
        cu("validate A1 weird", default_tab="Чек-лист")


def test_condition_missing_raises() -> None:
    # `cond add` с одним range и без условия → idx за пределами токенов.
    with pytest.raises(BatchScriptError, match="нет условия"):
        cu("cond add A1", default_tab="Чек-лист")


# ── conditional formatting ────────────────────────────────────────────────────


def test_cond_add_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="cond add: нужен range"):
        cu("cond add")


def test_cond_add_default_yellow_format() -> None:
    reqs = cu("cond add A1:A num>10", default_tab="Чек-лист")
    rule = reqs[0]["addConditionalFormatRule"]["rule"]
    assert rule["booleanRule"]["condition"]["type"] == "NUMBER_GREATER"
    # без стиль-флагов — дефолтная жёлтая заливка.
    assert "backgroundColor" in rule["booleanRule"]["format"]


def test_cond_clear_with_index() -> None:
    assert cu("cond clear 'Чек-лист' index=2") == [
        {"deleteConditionalFormatRule": {"sheetId": 615730406, "index": 2}}
    ]


def test_cond_clear_requires_sheet() -> None:
    with pytest.raises(BatchScriptError, match="cond clear: нужен лист"):
        cu("cond clear")


# ── protect / unprotect ───────────────────────────────────────────────────────


def test_protect_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="protect: нужен range"):
        cu("protect")


def test_protect_with_description() -> None:
    pr = cu("protect A1 desc='Защита'", default_tab="Чек-лист")[0]["addProtectedRange"][
        "protectedRange"
    ]
    assert pr["description"] == "Защита"


def test_unprotect_by_id() -> None:
    assert cu("unprotect id=42") == [{"deleteProtectedRange": {"protectedRangeId": 42}}]


def test_unprotect_requires_id() -> None:
    with pytest.raises(BatchScriptError, match="нужен id=N"):
        cu("unprotect foo")


# ── sheet ops ─────────────────────────────────────────────────────────────────


def test_sheet_add_requires_name() -> None:
    with pytest.raises(BatchScriptError, match="sheet add: нужно имя"):
        cu("sheet add")


def test_sheet_add_with_options() -> None:
    props = cu('sheet add "X" rows=50 cols=10 index=2')[0]["addSheet"]["properties"]
    assert props["index"] == 2
    assert props["gridProperties"] == {"rowCount": 50, "columnCount": 10}


def test_sheet_delete() -> None:
    assert cu("sheet delete 'Чек-лист'") == [{"deleteSheet": {"sheetId": 615730406}}]


def test_sheet_dup_with_new_name() -> None:
    assert cu("sheet dup 'Чек-лист' as 'Копия'") == [
        {"duplicateSheet": {"sourceSheetId": 615730406, "newSheetName": "Копия"}}
    ]


def test_sheet_dup_without_new_name() -> None:
    assert cu("sheet dup 'Чек-лист'") == [{"duplicateSheet": {"sourceSheetId": 615730406}}]


def test_sheet_dup_requires_sheet() -> None:
    with pytest.raises(BatchScriptError, match="sheet dup: нужен лист"):
        cu("sheet dup")


def test_sheet_rename() -> None:
    reqs = cu("sheet rename 'Чек-лист' 'Новое'")
    props = reqs[0]["updateSheetProperties"]["properties"]
    assert props == {"sheetId": 615730406, "title": "Новое"}


def test_sheet_rename_requires_two_args() -> None:
    with pytest.raises(BatchScriptError, match="sheet rename"):
        cu("sheet rename 'Чек-лист'")


def test_sheet_tab_color() -> None:
    reqs = cu("sheet tab 'Чек-лист' color=#ff0000")
    props = reqs[0]["updateSheetProperties"]["properties"]
    assert props["tabColor"] == {"red": 1.0, "green": 0.0, "blue": 0.0}


def test_sheet_tab_requires_two_args() -> None:
    with pytest.raises(BatchScriptError, match="sheet tab"):
        cu("sheet tab 'Чек-лист'")


def test_sheet_tab_requires_color() -> None:
    with pytest.raises(BatchScriptError, match="нужен color"):
        cu("sheet tab 'Чек-лист' foo")


# ── sort / dedupe / trim ──────────────────────────────────────────────────────


def test_sort_by_spec() -> None:
    specs = cu("sort A1:D10 by=B:desc,C", default_tab="Чек-лист")[0]["sortRange"]["sortSpecs"]
    assert specs == [
        {"dimensionIndex": 1, "sortOrder": "DESCENDING"},
        {"dimensionIndex": 2, "sortOrder": "ASCENDING"},
    ]


def test_sort_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="sort: нужен range"):
        cu("sort")


def test_sort_requires_by() -> None:
    with pytest.raises(BatchScriptError, match="by=COL"):
        cu("sort A1:D10", default_tab="Чек-лист")


def test_dedupe_with_compare_columns() -> None:
    req = cu("dedupe A1:D10 cols=A,B", default_tab="Чек-лист")[0]["deleteDuplicates"]
    assert [c["startIndex"] for c in req["comparisonColumns"]] == [0, 1]


def test_dedupe_requires_range() -> None:
    with pytest.raises(BatchScriptError, match="dedupe: нужен range"):
        cu("dedupe")


def test_trim() -> None:
    assert cu("trim A1:B2", default_tab="Чек-лист")[0]["trimWhitespace"]["range"]["sheetId"] == (
        615730406
    )


def test_trim_requires_arg() -> None:
    with pytest.raises(BatchScriptError, match="нужен аргумент"):
        cu("trim")


# ── named ranges ──────────────────────────────────────────────────────────────


def test_name_add() -> None:
    nr = cu("name add MyRange A1:B2", default_tab="Чек-лист")[0]["addNamedRange"]["namedRange"]
    assert nr["name"] == "MyRange"
    assert nr["range"]["sheetId"] == 615730406


def test_name_add_requires_two_args() -> None:
    with pytest.raises(BatchScriptError, match="name add"):
        cu("name add foo")


def test_name_del_by_id() -> None:
    assert cu("name del id=abc123") == [{"deleteNamedRange": {"namedRangeId": "abc123"}}]


def test_name_del_requires_id() -> None:
    with pytest.raises(BatchScriptError, match="нужен id"):
        cu("name del")


# ── autofill / copy / cut ─────────────────────────────────────────────────────


def test_autofill() -> None:
    req = cu("autofill A1:A3 -> A1:A10", default_tab="Чек-лист")[0]["autoFill"]
    assert req["useAlternateSeries"] is False
    assert req["range"]["endRowIndex"] == 10


def test_autofill_bad_syntax_raises() -> None:
    with pytest.raises(BatchScriptError, match="autofill"):
        cu("autofill A1:A3", default_tab="Чек-лист")


def test_copy_with_paste_type() -> None:
    req = cu("copy A1:B2 -> C1:D2 type=values", default_tab="Чек-лист")[0]["copyPaste"]
    assert req["pasteType"] == "PASTE_VALUES"
    assert req["destination"]["startColumnIndex"] == 2


def test_copy_default_paste_type() -> None:
    req = cu("copy A1:B2 -> C1:D2", default_tab="Чек-лист")[0]["copyPaste"]
    assert req["pasteType"] == "PASTE_NORMAL"


def test_cut_paste() -> None:
    req = cu("cut A1:B2 -> C1:D2", default_tab="Чек-лист")[0]["cutPaste"]
    assert "pasteType" not in req
    assert req["source"]["sheetId"] == 615730406


def test_copy_bad_syntax_raises() -> None:
    with pytest.raises(BatchScriptError, match="copyPaste"):
        cu("copy A1:B2", default_tab="Чек-лист")


# ── group / ungroup ───────────────────────────────────────────────────────────


def test_group_cols() -> None:
    req = cu("group cols H:J", default_tab="Чек-лист")[0]["addDimensionGroup"]
    assert req["range"]["dimension"] == "COLUMNS"


def test_ungroup_rows() -> None:
    req = cu("ungroup rows 2:5", default_tab="Чек-лист")[0]["deleteDimensionGroup"]
    assert req["range"]["dimension"] == "ROWS"


def test_group_bad_dimension_raises() -> None:
    with pytest.raises(BatchScriptError, match="DimensionGroup"):
        cu("group diagonal H:J", default_tab="Чек-лист")


def test_group_too_few_args_raises() -> None:
    with pytest.raises(BatchScriptError, match="DimensionGroup"):
        cu("group cols", default_tab="Чек-лист")


# ── чтение: дополнительные ветки ──────────────────────────────────────────────


def test_compile_read_rows_major_and_serial() -> None:
    plan = compile_read("get 'Чек-лист'!A1:B2 rows serial")
    assert plan.values is not None
    assert plan.values["majorDimension"] == "ROWS"
    assert plan.values["dateTimeRenderOption"] == "SERIAL_NUMBER"


def test_compile_read_dedupes_aspect() -> None:
    plan = compile_read("read merges merges")
    assert plan.meta == {"aspects": ["merges"], "sheets": []}


def test_compile_read_bad_verb_raises() -> None:
    with pytest.raises(BatchScriptError, match="должен быть"):
        compile_read("frobnicate x")


def test_compile_read_empty_script_raises() -> None:
    with pytest.raises(BatchScriptError, match="пустой скрипт"):
        compile_read("")


def test_compile_read_range_without_default_tab() -> None:
    plan = compile_read("get A1:B2")
    assert plan.values is not None
    assert plan.values["ranges"] == ["A1:B2"]


# ── filter_meta ───────────────────────────────────────────────────────────────


def _sample_spreadsheet() -> dict[str, Any]:
    return {
        "namedRanges": [{"name": "X"}],
        "sheets": [
            {
                "properties": {"title": "Чек-лист"},
                "merges": [{"m": 1}],
                "conditionalFormats": [{"c": 1}],
            },
            {"properties": {"title": "Other"}, "merges": [{"m": 2}]},
            {"merges": [{"m": 3}]},
        ],
    }


def test_filter_meta_named_and_sheet_aspect_filtered_by_title() -> None:
    out = filter_meta(_sample_spreadsheet(), ["named", "merges"], ["Чек-лист"])
    assert out["namedRanges"] == [{"name": "X"}]
    assert out["sheets"] == [{"title": "Чек-лист", "merges": [{"m": 1}]}]


def test_filter_meta_only_named_short_circuits() -> None:
    out = filter_meta(_sample_spreadsheet(), ["named"], [])
    assert out == {"namedRanges": [{"name": "X"}]}
    assert "sheets" not in out


def test_filter_meta_all_sheets_no_title_filter() -> None:
    out = filter_meta(_sample_spreadsheet(), ["merges"], [])
    titles = [row["title"] for row in out["sheets"]]
    assert titles == ["Чек-лист", "Other", ""]
