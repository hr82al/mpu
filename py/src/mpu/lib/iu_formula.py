"""Мердж ИУ-данных в формулы листа UNIT (или сборка из шаблона).

Формула 1 (колонка I) держит `iu_; { {"subject_name" \\ pct}; ... }` — subject_name → % МП.
Формула 2 (S4) держит `iu_zero_nm_ids; { id; ... }` — nm_id для зануления логистики/хранения.

Логика:
- если в формуле есть нужный блок — обновляем/добавляем целевые записи (остальное как есть);
- если блока нет (другая формула / пусто) — берём канонический шаблон (`iu_templates/`) и
  вписываем только целевые данные.
"""

from __future__ import annotations

import re
from pathlib import Path

_TEMPLATE_FILE = {"perc": "formula1.tmpl", "zero": "formula2.tmpl"}
_PERC_ANCHOR = r"\biu_\s*;"
_ZERO_ANCHOR = r"\biu_zero_nm_ids\s*;"


def _load_template(kind: str) -> str:
    return (Path(__file__).parent / "iu_templates" / _TEMPLATE_FILE[kind]).read_text(
        encoding="utf-8"
    )


def find_block(text: str, anchor_re: str) -> tuple[int, int]:
    """(i, j) — индексы открывающей `{` и парной `}` блока после анкера."""
    m = re.search(anchor_re, text)
    if not m:
        raise ValueError(f"анкер не найден: {anchor_re}")
    i = text.index("{", m.end())
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return i, j
    raise ValueError("несбалансированные скобки в блоке")


def set_block(text: str, anchor_re: str, inner: str) -> str:
    i, j = find_block(text, anchor_re)
    return text[:i] + "{\n" + inner + "\n  }" + text[j + 1 :]


def _num_comma(x: float) -> str:
    """34.72 -> '34,72', 30.0 -> '30' (десятичный разделитель — запятая, как в листе)."""
    return f"{float(x):g}".replace(".", ",")


def merge_iu_perc(current: str, subject_perc: dict[str, float]) -> str:
    """Блок `iu_`: обновить/добавить `{"subject" \\ perc%}`; нет блока → шаблон + только целевые."""
    has_block = bool(current.strip()) and re.search(_PERC_ANCHOR, current) is not None
    base = current if has_block else _load_template("perc")
    i, j = find_block(base, _PERC_ANCHOR)
    inner = base[i + 1 : j]

    pairs: list[list[str]] = []  # [name, value_str]
    seen: dict[str, int] = {}
    for m in re.finditer(r'\{\s*"([^"]*)"\s*\\\s*([^}]*?)\s*\}', inner):
        name = m.group(1)
        seen[name] = len(pairs)
        pairs.append([name, m.group(2).strip()])
    for name, pct in subject_perc.items():
        val = _num_comma(pct)
        if name in seen:
            pairs[seen[name]][1] = val
        else:
            seen[name] = len(pairs)
            pairs.append([name, val])

    rows = ";\n".join(f'    {{"{name}" \\ {val}}}' for name, val in pairs)
    return set_block(base, _PERC_ANCHOR, rows)


def merge_iu_zero(current: str, nm_ids: list[int]) -> str:
    """Блок `iu_zero_nm_ids`: union существующих и целевых nm_id; нет блока → шаблон + целевые."""
    has_block = bool(current.strip()) and re.search(_ZERO_ANCHOR, current) is not None
    base = current if has_block else _load_template("zero")
    i, j = find_block(base, _ZERO_ANCHOR)
    inner = base[i + 1 : j]

    seen: set[int] = set()
    merged: list[int] = []
    for x in re.findall(r"\d+", inner):
        n = int(x)
        if n not in seen:
            seen.add(n)
            merged.append(n)
    for n in nm_ids:
        if n not in seen:
            seen.add(n)
            merged.append(n)

    rows = ";\n".join(f"    {n}" for n in merged)
    return set_block(base, _ZERO_ANCHOR, rows)
