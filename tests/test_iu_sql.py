"""Тесты сборщика SQL простановки ИУ — `mpu.lib.iu_sql`.

Модуль — чистый строитель SQL-строк (без сети/БД), поэтому тесты снимают
снапшоты подстрок сгенерированного запроса и проверяют форматирование чисел.
"""

# _fmt_num — приватный хелпер модуля, тестируется напрямую (как в test_logs_loki.py).
# pyright: reportPrivateUsage=false

from mpu.lib.iu_sql import _fmt_num, build_iu_sql

# Столбцы, которые ON CONFLICT обязан обновлять (всё, что вставляем).
_CONFLICT_COLS = (
    "perc_mp",
    "discounted_price",
    "spp",
    "turnover",
    "buyout_percent",
    "volume",
    "delivery_mp_with_buyout_rub",
    "hranenie_rub",
    "tax_type",
)


# --- _fmt_num ---------------------------------------------------------------


def test_fmt_num_integer_valued_float_has_no_decimal() -> None:
    """Целочисленное значение float печатается без хвоста: 30.0 -> '30'."""
    assert _fmt_num(30.0) == "30"


def test_fmt_num_keeps_fractional_digits() -> None:
    """Дробное значение сохраняется как есть: 34.72 -> '34.72'."""
    assert _fmt_num(34.72) == "34.72"


def test_fmt_num_zero() -> None:
    """Ноль печатается как '0', без '0.0'."""
    assert _fmt_num(0.0) == "0"


def test_fmt_num_negative() -> None:
    """Отрицательные сохраняют знак: -5.5 -> '-5.5'."""
    assert _fmt_num(-5.5) == "-5.5"


def test_fmt_num_small_value_uses_sci_notation() -> None:
    """Очень малое значение уходит в научную нотацию ('%g'): 1e-7 -> '1e-07'."""
    assert _fmt_num(1e-7) == "1e-07"


def test_fmt_num_large_value_uses_sci_notation() -> None:
    """Большое значение режется до 6 значащих и уходит в e-нотацию."""
    assert _fmt_num(1234567.0) == "1.23457e+06"


def test_fmt_num_uses_dot_decimal_separator() -> None:
    """Десятичный разделитель — точка, не запятая (SQL-литерал)."""
    assert "," not in _fmt_num(0.1)
    assert _fmt_num(0.1) == "0.1"


# --- build_iu_sql: VALUES / ordering ---------------------------------------


def _make_sql(rows: list[tuple[int, float]]) -> str:
    return build_iu_sql(
        schema="schema_1311",
        proto_table="wb_unit_proto",
        date_from="2026-01-01",
        date_to="2026-01-31",
        rows=rows,
    )


def test_single_row_values_literal() -> None:
    """Одна строка раскрывается в `(ord, nm_id::bigint, perc::numeric)`."""
    sql = _make_sql([(12345, 30.0)])
    assert "(1, 12345::bigint, 30::numeric)" in sql


def test_single_row_decimal_perc_formatted_via_fmt_num() -> None:
    """perc прогоняется через `_fmt_num` (дробное сохраняется)."""
    sql = _make_sql([(777, 34.72)])
    assert "(1, 777::bigint, 34.72::numeric)" in sql


def test_multi_row_ordinals_are_one_based_and_in_order() -> None:
    """ord = enumerate+1, строки идут в порядке входа, разделитель — `,\\n        `."""
    sql = _make_sql([(11, 30.0), (22, 34.72), (33, 0.0)])
    expected_values_block = (
        "        (1, 11::bigint, 30::numeric),\n"
        "        (2, 22::bigint, 34.72::numeric),\n"
        "        (3, 33::bigint, 0::numeric)"
    )
    assert expected_values_block in sql


def test_multi_row_preserves_input_order_not_sorted() -> None:
    """Порядок строк не сортируется — ord следует входной последовательности."""
    sql = _make_sql([(99, 10.0), (11, 20.0)])
    assert "(1, 99::bigint, 10::numeric)" in sql
    assert "(2, 11::bigint, 20::numeric)" in sql
    # 99 идёт раньше 11 в тексте
    assert sql.index("(1, 99::bigint") < sql.index("(2, 11::bigint")


# --- build_iu_sql: generate_series / dates ---------------------------------


def test_generate_series_uses_date_from_and_date_to() -> None:
    """Диапазон дат подставляется в generate_series как date-литералы."""
    sql = build_iu_sql(
        schema="s",
        proto_table="p",
        date_from="2026-02-01",
        date_to="2026-02-05",
        rows=[(1, 1.0)],
    )
    assert "generate_series('2026-02-01'::date, '2026-02-05'::date, '1 day') AS d" in sql


def test_date_from_equals_date_to_single_day() -> None:
    """Один день: date_from == date_to — подставляются обе границы."""
    sql = build_iu_sql(
        schema="s", proto_table="p", date_from="2026-03-09", date_to="2026-03-09", rows=[(1, 1.0)]
    )
    assert "generate_series('2026-03-09'::date, '2026-03-09'::date, '1 day')" in sql


# --- build_iu_sql: schema / proto_table escaping ---------------------------


def test_schema_is_wrapped_in_double_quoted_ident() -> None:
    """Схема оборачивается в двойные кавычки во всех ссылках на таблицы."""
    sql = _make_sql([(1, 1.0)])
    assert '"schema_1311".wb_cards' in sql
    assert '"schema_1311".wb_unit_proto' in sql
    assert 'INSERT INTO "schema_1311".wb_unit_manual_data' in sql


def test_proto_table_appears_in_target_subselect() -> None:
    """proto_table подставляется в `nm_id IN (SELECT nm_id FROM "schema".<proto>)`."""
    sql = build_iu_sql(
        schema="schema_42",
        proto_table="ozon_unit_proto",
        date_from="2026-01-01",
        date_to="2026-01-02",
        rows=[(1, 1.0)],
    )
    assert 'SELECT nm_id FROM "schema_42".ozon_unit_proto' in sql


def test_schema_and_proto_substituted_literally() -> None:
    """Подстановка буквальная — необычные (но валидные) имена проходят как есть."""
    sql = build_iu_sql(
        schema="schema_999",
        proto_table="wb_unit_proto",
        date_from="2026-01-01",
        date_to="2026-01-02",
        rows=[(1, 1.0)],
    )
    # shared.wb_subjects — фиксированная схема, не параметризуется
    assert "JOIN shared.wb_subjects wbs USING (subject_id)" in sql
    assert '"schema_999".wb_cards' in sql


# --- build_iu_sql: INSERT defaults / ON CONFLICT ---------------------------


def test_insert_column_list_complete() -> None:
    """INSERT перечисляет все 11 колонок целевой таблицы."""
    sql = _make_sql([(1, 1.0)])
    assert (
        "(date, nm_id, perc_mp, discounted_price, spp, turnover, buyout_percent,\n"
        "     volume, delivery_mp_with_buyout_rub, hranenie_rub, tax_type)" in sql
    )


def test_select_defaults_null_and_zero_for_missing_fields() -> None:
    """Отсутствующие поля — NULL; логистика/хранение — 0::numeric; tax_type NULL::varchar."""
    sql = _make_sql([(1, 1.0)])
    assert "d::date, t.nm_id, sp.perc / 100.0, NULL, NULL, NULL, NULL, NULL," in sql
    assert "0::numeric, 0::numeric, NULL::varchar" in sql


def test_perc_divided_by_100_in_select() -> None:
    """perc_mp = perc / 100.0 (проценты → доля)."""
    sql = _make_sql([(1, 1.0)])
    assert "sp.perc / 100.0" in sql


def test_on_conflict_target_is_date_nm_id() -> None:
    """Конфликт по (date, nm_id) — UPSERT по первичному ключу таблицы."""
    sql = _make_sql([(1, 1.0)])
    assert "ON CONFLICT (date, nm_id) DO UPDATE SET" in sql


def test_on_conflict_updates_every_inserted_column() -> None:
    """ON CONFLICT обновляет каждую вставляемую колонку через EXCLUDED."""
    sql = _make_sql([(1, 1.0)])
    for col in _CONFLICT_COLS:
        assert f"{col} = EXCLUDED.{col}" in sql


def test_sql_is_terminated_with_semicolon() -> None:
    """Запрос завершается `;` (self-contained, готов к выполнению)."""
    sql = _make_sql([(1, 1.0)])
    assert sql.rstrip().endswith(";")


# --- build_iu_sql: edge cases ----------------------------------------------


def test_empty_rows_does_not_raise_and_returns_str() -> None:
    """Пустой список строк не падает: VALUES-блок пустой, остальной SQL цел."""
    sql = _make_sql([])
    assert isinstance(sql, str)
    # пустой join → между VALUES и закрывающей скобкой только отступ
    assert "VALUES\n        \n)" in sql
    # каркас запроса сохранён даже без строк
    assert "INSERT INTO" in sql
    assert sql.rstrip().endswith(";")


def test_idempotent_same_input_same_output() -> None:
    """Чистая функция: одинаковый вход → побайтово одинаковый выход."""
    rows: list[tuple[int, float]] = [(11, 30.0), (22, 34.72)]
    assert _make_sql(rows) == _make_sql(rows)


def test_full_structure_has_all_named_ctes() -> None:
    """Каркас CTE на месте: input → latest_cards → input_subjects → subject_perc → target_nm."""
    sql = _make_sql([(1, 5.0)])
    for cte in (
        "input(ord, nm_id, perc) AS",
        "latest_cards AS",
        "input_subjects AS",
        "subject_perc AS",
        "target_nm AS",
    ):
        assert cte in sql
