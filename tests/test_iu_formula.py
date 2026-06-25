"""Тесты merge/строковых трансформаций ИУ-формул в `lib/iu_formula.py`.

Покрывают: загрузку шаблонов, поиск блока по анкеру (+ ошибочные пути),
форматирование числа с запятой, и оба merge'а (perc / zero) — обновление,
добавление, дедуп, сохранение порядка и fallback на шаблон при отсутствии блока.
"""
# pyright: reportPrivateUsage=false

import pytest

from mpu.lib import iu_formula
from mpu.lib.iu_formula import (
    _PERC_ANCHOR,
    _ZERO_ANCHOR,
    _load_template,
    _num_comma,
    find_block,
    merge_iu_perc,
    merge_iu_zero,
    set_block,
)

# ---------------------------------------------------------------- _load_template


def test_load_template_perc_has_iu_anchor() -> None:
    """perc-шаблон — реальный formula1.tmpl с пустым блоком `iu_; { }`."""
    tmpl = _load_template("perc")
    assert tmpl.startswith("=LET(")
    assert "subject_name" in tmpl
    # анкер блока присутствует — merge сможет найти куда вписывать
    find_block(tmpl, _PERC_ANCHOR)


def test_load_template_zero_has_zero_anchor() -> None:
    """zero-шаблон — реальный formula2.tmpl с блоком `iu_zero_nm_ids; { }`."""
    tmpl = _load_template("zero")
    assert "iu_zero_nm_ids" in tmpl
    assert "KEYSQUERY" in tmpl
    find_block(tmpl, _ZERO_ANCHOR)


def test_load_template_unknown_kind_raises_keyerror() -> None:
    """Неизвестный вид шаблона — KeyError по словарю _TEMPLATE_FILE."""
    with pytest.raises(KeyError):
        _load_template("nope")


# ---------------------------------------------------------------- find_block


def _assert_balanced(text: str, i: int, j: int) -> None:
    """Между i и j скобки сбалансированы и концы — это `{`/`}`."""
    assert text[i] == "{"
    assert text[j] == "}"
    depth = 0
    for ch in text[i : j + 1]:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        assert depth >= 0
    assert depth == 0


def test_find_block_simple_indices() -> None:
    """`iu_; {x}` → открывающая `{` на 5, парная `}` на 7."""
    assert find_block("iu_; {x}", _PERC_ANCHOR) == (5, 7)


def test_find_block_nested_returns_outer_pair() -> None:
    """Вложенные скобки — возвращается ВНЕШНЯЯ пара, не первая `}`."""
    text = "iu_; { a {b} c }"
    i, j = find_block(text, _PERC_ANCHOR)
    assert (i, j) == (5, 15)
    _assert_balanced(text, i, j)
    assert text[i : j + 1] == "{ a {b} c }"


def test_find_block_zero_anchor() -> None:
    """Анкер zero-блока находит свой `{...}`."""
    text = "x iu_zero_nm_ids; {\n  1\n} y"
    i, j = find_block(text, _ZERO_ANCHOR)
    _assert_balanced(text, i, j)


def test_find_block_anchor_missing_raises() -> None:
    """Анкер не найден → ValueError с текстом анкера в сообщении."""
    with pytest.raises(ValueError, match=r"анкер не найден"):
        find_block("no anchor here", _PERC_ANCHOR)


def test_find_block_unbalanced_braces_raises() -> None:
    """Открытых `{` больше, чем закрытых → 'несбалансированные скобки'."""
    with pytest.raises(ValueError, match=r"несбалансированные скобки"):
        find_block("iu_; { a {b }", _PERC_ANCHOR)


def test_find_block_anchor_but_no_brace_raises() -> None:
    """Анкер есть, но `{` после него нет → ValueError от str.index."""
    with pytest.raises(ValueError, match=r"substring not found"):
        find_block("iu_; nothing", _PERC_ANCHOR)


# ---------------------------------------------------------------- set_block


def test_set_block_replaces_inner_with_wrapping() -> None:
    """set_block заменяет содержимое блока на `{\\n` + inner + `\\n  }`."""
    out = set_block("pre iu_; {OLD} post", _PERC_ANCHOR, "    NEW")
    assert out == "pre iu_; {\n    NEW\n  } post"


def test_set_block_propagates_missing_anchor() -> None:
    """set_block наследует ошибку find_block при отсутствии анкера."""
    with pytest.raises(ValueError, match=r"анкер не найден"):
        set_block("plain text", _PERC_ANCHOR, "x")


# ---------------------------------------------------------------- _num_comma


def test_num_comma_integral_float_no_decimals() -> None:
    """Целое значение — без дробной части: 30.0 -> '30'."""
    assert _num_comma(30.0) == "30"


def test_num_comma_keeps_two_decimals_with_comma() -> None:
    """34.72 -> '34,72' (десятичный разделитель — запятая)."""
    assert _num_comma(34.72) == "34,72"


def test_num_comma_accepts_int() -> None:
    """int приводится к float: 30 -> '30'."""
    assert _num_comma(30) == "30"


def test_num_comma_negative() -> None:
    """Отрицательное: -5.5 -> '-5,5'."""
    assert _num_comma(-5.5) == "-5,5"


def test_num_comma_zero() -> None:
    """0.0 -> '0'."""
    assert _num_comma(0.0) == "0"


def test_num_comma_scientific_notation_keeps_comma() -> None:
    """Большое число уходит в экспоненту, точка мантиссы → запятая."""
    assert _num_comma(123456789.0) == "1,23457e+08"


def test_num_comma_small_fraction() -> None:
    """Малая дробь: 0.0001 -> '0,0001'."""
    assert _num_comma(0.0001) == "0,0001"


def test_num_comma_g_precision_truncates() -> None:
    """:g даёт 6 значащих цифр: 1/3 -> '0,333333'."""
    assert _num_comma(1.0 / 3.0) == "0,333333"


# ---------------------------------------------------------------- merge_iu_perc


def test_merge_iu_perc_updates_existing_subject() -> None:
    """Существующий subject обновляется по значению, не дублируется."""
    cur = 'head iu_; {\n    {"Носки" \\ 10}\n  } tail'
    out = merge_iu_perc(cur, {"Носки": 15.0})
    assert out == 'head iu_; {\n    {"Носки" \\ 15}\n  } tail'


def test_merge_iu_perc_appends_new_subject_after_existing() -> None:
    """Новый subject добавляется ПОСЛЕ существующих, порядок сохраняется."""
    cur = 'head iu_; {\n    {"Носки" \\ 10}\n  } tail'
    out = merge_iu_perc(cur, {"Майки": 20.0})
    assert out == ('head iu_; {\n    {"Носки" \\ 10};\n    {"Майки" \\ 20}\n  } tail')


def test_merge_iu_perc_override_preserves_order_of_others() -> None:
    """Обновление одного subject не сдвигает порядок остальных."""
    cur = 'iu_; {\n    {"A" \\ 10};\n    {"B" \\ 20}\n  }'
    out = merge_iu_perc(cur, {"A": 99.0})
    assert out == 'iu_; {\n    {"A" \\ 99};\n    {"B" \\ 20}\n  }'


def test_merge_iu_perc_comma_decimal_value() -> None:
    """Дробное значение раскладывается через запятую внутри пары."""
    cur = "iu_; {\n  } end"
    out = merge_iu_perc(cur, {"C": 12.5})
    assert out == 'iu_; {\n    {"C" \\ 12,5}\n  } end'


def test_merge_iu_perc_no_block_uses_template() -> None:
    """Нет perc-блока в current → берётся шаблон, вписывается только целевое."""
    out = merge_iu_perc("=A1+B1", {"NewSubj": 5.0})
    assert out.startswith("=LET(")
    assert "subject_name" in out  # маркер шаблона formula1
    assert '{"NewSubj" \\ 5}' in out


def test_merge_iu_perc_empty_current_uses_template() -> None:
    """Пустой current → шаблон."""
    out = merge_iu_perc("", {"X": 1.0})
    assert out.startswith("=LET(")
    assert '{"X" \\ 1}' in out


def test_merge_iu_perc_whitespace_only_uses_template() -> None:
    """Current из одних пробелов считается пустым → шаблон."""
    out = merge_iu_perc("   ", {"Y": 2.0})
    assert out.startswith("=LET(")
    assert '{"Y" \\ 2}' in out


def test_merge_iu_perc_empty_subjects_renders_existing() -> None:
    """Пустой dict субъектов → блок перерендерен с теми же значениями."""
    cur = 'iu_; {\n    {"Носки" \\ 10}\n  }'
    out = merge_iu_perc(cur, {})
    assert out == 'iu_; {\n    {"Носки" \\ 10}\n  }'


def test_merge_iu_perc_is_idempotent() -> None:
    """Повторный merge с тем же входом ничего не меняет."""
    cur = 'iu_; {\n    {"Носки" \\ 10}\n  }'
    once = merge_iu_perc(cur, {"Майки": 20.0})
    twice = merge_iu_perc(once, {"Майки": 20.0})
    assert once == twice


def test_merge_iu_perc_uses_monkeypatched_template(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fallback-путь использует ровно то, что вернул _load_template."""
    fake = "FAKE iu_; {\n  } END"

    def fake_load(kind: str) -> str:
        assert kind == "perc"
        return fake

    monkeypatch.setattr(iu_formula, "_load_template", fake_load)
    out = merge_iu_perc("=not_a_block", {"Z": 7.0})
    assert out == 'FAKE iu_; {\n    {"Z" \\ 7}\n  } END'


# ---------------------------------------------------------------- merge_iu_zero


def test_merge_iu_zero_merges_new_nm_id() -> None:
    """Новый nm_id добавляется к существующим в порядке прихода."""
    cur = "pre iu_zero_nm_ids; {\n    111\n  } post"
    out = merge_iu_zero(cur, [222])
    assert out == "pre iu_zero_nm_ids; {\n    111;\n    222\n  } post"


def test_merge_iu_zero_dedups_new_against_existing() -> None:
    """nm_id, уже присутствующий, не дублируется."""
    cur = "iu_zero_nm_ids; {\n    111\n  }"
    out = merge_iu_zero(cur, [111, 333])
    assert out == "iu_zero_nm_ids; {\n    111;\n    333\n  }"


def test_merge_iu_zero_preserves_order() -> None:
    """Существующие сохраняют порядок; новые добавляются в хвост."""
    cur = "iu_zero_nm_ids; {\n    111;\n    222\n  }"
    out = merge_iu_zero(cur, [333, 111])
    assert out == "iu_zero_nm_ids; {\n    111;\n    222;\n    333\n  }"


def test_merge_iu_zero_dedups_within_existing_inner() -> None:
    """Дубли уже внутри блока схлопываются при перерендере."""
    cur = "iu_zero_nm_ids; {\n    111; 111; 222\n  }"
    out = merge_iu_zero(cur, [333])
    assert out == "iu_zero_nm_ids; {\n    111;\n    222;\n    333\n  }"


def test_merge_iu_zero_no_block_uses_template() -> None:
    """Нет zero-блока → берётся formula2-шаблон, вписываются только целевые id."""
    out = merge_iu_zero("=OTHER", [555, 666])
    assert "KEYSQUERY" in out  # маркер шаблона formula2
    assert "    555;\n    666" in out


def test_merge_iu_zero_empty_current_uses_template() -> None:
    """Пустой current → шаблон."""
    out = merge_iu_zero("", [777])
    assert "iu_zero_nm_ids" in out
    assert "    777" in out


def test_merge_iu_zero_empty_nm_ids_renders_existing() -> None:
    """Пустой список целевых → блок перерендерен с теми же id."""
    cur = "iu_zero_nm_ids; {\n    111;\n    222\n  }"
    out = merge_iu_zero(cur, [])
    assert out == "iu_zero_nm_ids; {\n    111;\n    222\n  }"


def test_merge_iu_zero_is_idempotent() -> None:
    """Повторный merge с теми же id ничего не меняет."""
    cur = "iu_zero_nm_ids; {\n    111\n  }"
    once = merge_iu_zero(cur, [222])
    twice = merge_iu_zero(once, [222])
    assert once == twice


def test_merge_iu_zero_uses_monkeypatched_template(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fallback-путь zero использует возвращённый _load_template дословно."""
    fake = "FAKE iu_zero_nm_ids; {\n  } END"

    def fake_load(kind: str) -> str:
        assert kind == "zero"
        return fake

    monkeypatch.setattr(iu_formula, "_load_template", fake_load)
    out = merge_iu_zero("=not_a_block", [42])
    assert out == "FAKE iu_zero_nm_ids; {\n    42\n  } END"
