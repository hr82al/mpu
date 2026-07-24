"""Сборка self-contained SQL простановки ИУ в `wb_unit_manual_data`.

По входным `[(nm_id, perc)]` SQL сам резолвит категории (`subject_name`), берёт perc первого
по порядку nm_id на категорию, раскрывает до всех nm_id этих категорий (∩ proto-таблица) и
делает `INSERT ... ON CONFLICT DO UPDATE` (perc_mp = perc/100, delivery/hranenie = 0, прочее NULL).
"""

from __future__ import annotations


def _fmt_num(x: float) -> str:
    """SQL-литерал с точкой-десятичным; целые без хвоста (34.72 -> '34.72', 30.0 -> '30')."""
    return f"{x:g}"


def build_iu_sql(
    *,
    schema: str,
    proto_table: str,
    date_from: str,
    date_to: str,
    rows: list[tuple[int, float]],
) -> str:
    values = ",\n        ".join(
        f"({i + 1}, {nm_id}::bigint, {_fmt_num(perc)}::numeric)"
        for i, (nm_id, perc) in enumerate(rows)
    )
    return f"""WITH input(ord, nm_id, perc) AS (
    VALUES
        {values}
),
latest_cards AS (
    SELECT DISTINCT ON (wc.nm_id) wc.nm_id, wbs.subject_name
    FROM "{schema}".wb_cards wc
    JOIN shared.wb_subjects wbs USING (subject_id)
    ORDER BY wc.nm_id, wc.updated_at DESC NULLS LAST
),
input_subjects AS (
    SELECT i.ord, lc.subject_name, i.perc
    FROM input i
    JOIN latest_cards lc ON lc.nm_id = i.nm_id
    WHERE lc.subject_name IS NOT NULL
),
subject_perc AS (
    SELECT DISTINCT ON (subject_name) subject_name, perc
    FROM input_subjects
    ORDER BY subject_name, ord
),
target_nm AS (
    SELECT DISTINCT lc.nm_id, lc.subject_name
    FROM latest_cards lc
    JOIN subject_perc sp USING (subject_name)
    WHERE lc.nm_id IN (SELECT nm_id FROM "{schema}".{proto_table})
)
INSERT INTO "{schema}".wb_unit_manual_data
    (date, nm_id, perc_mp, discounted_price, spp, turnover, buyout_percent,
     volume, delivery_mp_with_buyout_rub, hranenie_rub, tax_type)
SELECT
    d::date, t.nm_id, sp.perc / 100.0, NULL, NULL, NULL, NULL, NULL,
    0::numeric, 0::numeric, NULL::varchar
FROM generate_series('{date_from}'::date, '{date_to}'::date, '1 day') AS d
CROSS JOIN target_nm t
JOIN subject_perc sp ON sp.subject_name = t.subject_name
ON CONFLICT (date, nm_id) DO UPDATE SET
    perc_mp = EXCLUDED.perc_mp,
    discounted_price = EXCLUDED.discounted_price,
    spp = EXCLUDED.spp,
    turnover = EXCLUDED.turnover,
    buyout_percent = EXCLUDED.buyout_percent,
    volume = EXCLUDED.volume,
    delivery_mp_with_buyout_rub = EXCLUDED.delivery_mp_with_buyout_rub,
    hranenie_rub = EXCLUDED.hranenie_rub,
    tax_type = EXCLUDED.tax_type;"""
