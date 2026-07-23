"""Подгон таблицы под ширину терминала: обрезка текста и бюджет свободной колонки.

Общее для `mpu glab-status` и `mpu kiten status`. Ширина везде считается в терминальных
ЯЧЕЙКАХ (`rich.cells.cell_len`), а не в символах: emoji и CJK занимают две ячейки, и
подсчёт по `len` разъезжает колонки.
"""

from __future__ import annotations

from rich.cells import cell_len, set_cell_size


def fit_text(text: str, budget: int) -> str:
    """Обрезать text до budget терминальных ячеек с хвостом `…`.

    budget<=0 → пусто; помещается целиком → как есть.
    """
    if budget <= 0:
        return ""
    if cell_len(text) <= budget:
        return text
    if budget == 1:
        return "…"
    return set_cell_size(text, budget - 1) + "…"


def pad_to(text: str, width: int, *, right: bool = False) -> str:
    """Дополнить text пробелами до width терминальных ЯЧЕЕК (не символов).

    Нужно там, где колонки выравниваются вручную (не через rich.Table): f-string вида
    `{text:<10}` считает символы, и одна emoji (2 ячейки) сдвигает всю строку.
    """
    gap = max(0, width - cell_len(text))
    return " " * gap + text if right else text + " " * gap


def table_chrome(num_columns: int) -> int:
    """Ячейки, съедаемые хромом rich-таблицы: (n+1) бордеров + 2n паддингов."""
    return 3 * num_columns + 1


def free_budget(console_width: int, fixed_widths: list[int], num_columns: int) -> int:
    """Сколько ячеек остаётся свободной колонке после фиксированных колонок и хрома.

    `num_columns` — ВСЕ колонки таблицы, включая свободную: хром считается по ним.
    """
    return console_width - table_chrome(num_columns) - sum(fixed_widths)
