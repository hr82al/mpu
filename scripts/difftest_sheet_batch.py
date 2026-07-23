#!/usr/bin/env python
"""Дифференциальное сравнение компилятора мини-языка Sheets с эталонной ревизией.

Зачем: у `lib/sheet_batch.py` 99% покрытия, но покрытие меряет «исполнилась ли строка»,
а не «на каком входе» — в этом же репозитории баг экранирования апострофа в A1-именах жил
при полностью покрытых строках. Для компилятора пространство входов комбинаторное, поэтому
перед рефакторингом здесь сравнивают ВЫХОД старой и новой реализации на десятках тысяч
сгенерированных скриптов: расхождений быть не должно ни одного.

    python scripts/difftest_sheet_batch.py --ref HEAD --count 20000

`--ref` — git-ревизия эталона (обычно последний коммит до рефакторинга).
Выход 0 — реализации эквивалентны; 1 — печатает первые расхождения со входом; 2 — прогон
не показателен (мало входов дошло до результата, сравнивались тексты ошибок).

Ограничение: из эталонной ревизии берётся ТОЛЬКО `sheet_batch.py`, зависимости
(`sheet_cache` и прочее) — из рабочего дерева. Поэтому инструмент проверяет изменения
в самом компиляторе; правку в зависимости он не увидит — проверено мутацией, там нужен
отдельный прогон против неё же.

Проверено, что инструмент не «зелёный по построению»: мутация `split_statements` (снят учёт
границы токена перед `#`) даёт 716 расхождений из 3000.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import subprocess
import sys
import tempfile
import types
from pathlib import Path

MODULE_PATH = "src/mpu/lib/sheet_batch.py"

# Ниже этой доли реальных компиляций прогон не показателен: сравниваются тексты ошибок.
MIN_COMPILED_SHARE = 0.5

# Куски грамматики (docs/sheet-batch.md). Специально включены места, где парсер исторически
# ошибался: кавычки в именах листов, `;` и `#` внутри строк, открытые диапазоны, R1C1.
TABS = ["", "Sheet1!", "'My Sheet'!", "'Чек-лист'!", "'John''s'!", "'01.2026'!", "Лист_1!"]
SPANS = ["H", "8", "H:J", "8:10", "H5", "r5c8", "H2:J10", "H:H", "H2:H", "4:4", "A1:C3"]
VALUES = [
    "1",
    "3.14",
    "true",
    "false",
    "текст",
    "'строка с пробелом'",
    "=SUM(A1;B2)",
    "=A1+1",
    '"# не комментарий"',
    "bg=#EA4335",
    "",
]
VERBS = [
    "set {range} {value}",
    'label {range} "Заголовок" bg=#EA4335 fg=#fff bold center',
    'style {range} bg=#FCE8E6 fmt="0.00%"',
    "clear {range} all",
    "clear {range} values",
    'note {range} "комментарий"',
    "cols insert {col} +10 inherit=before",
    "cols delete {col}",
    "rows insert {row} +2",
    "rows delete {row}",
    "cols hide {col}",
    "merge {range}",
    "merge {range} rows",
    "freeze rows=4 cols=7",
    "border {range} all style=SOLID color=#000",
    "find-replace foo bar",
    "find-replace /re.*x/ bar case allsheets",
    "sort {range} by=A,C:desc",
    "protect {range}",
    "dedupe {range}",
    'sheet add "Новый"',
    "sheet rename Sheet1 Другой",
    'raw {{"repeatCell": {{"range": {{"sheetId": 0}}}}}}',
    '@updateBorders {{"range": {{"sheetId": 0}}}}',
]
READ_VERBS = ["get {range}", "get {range} rows", "read merges", "read sheets", "get {range} serial"]
SEPARATORS = ["\n", "; ", "\n# комментарий\n", "\n\n"]


def _statement(rnd: random.Random, verbs: list[str]) -> str:
    template = rnd.choice(verbs)
    return template.format(
        range=rnd.choice(TABS) + rnd.choice(SPANS),
        col=rnd.choice(["H", "H:J", "B"]),
        row=rnd.choice(["4", "4:8", "10"]),
        value=rnd.choice(VALUES),
    )


def generate(rnd: random.Random, verbs: list[str]) -> str:
    """Скрипт мини-языка из 1–5 инструкций со случайными разделителями."""
    parts = [_statement(rnd, verbs) for _ in range(rnd.randint(1, 5))]
    out = parts[0]
    for part in parts[1:]:
        out += rnd.choice(SEPARATORS) + part
    return out


def load_reference(rev: str) -> types.ModuleType:
    """Модуль `sheet_batch` из git-ревизии `rev`, загруженный под отдельным именем."""
    blob = subprocess.run(
        ["git", "show", f"{rev}:{MODULE_PATH}"], capture_output=True, text=True, check=True
    ).stdout
    tmp = Path(tempfile.mkdtemp()) / "sheet_batch_reference.py"
    tmp.write_text(blob, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("sheet_batch_reference", tmp)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["sheet_batch_reference"] = module
    spec.loader.exec_module(module)
    return module


SHEET_IDS = {"Sheet1": 0, "My Sheet": 1, "Чек-лист": 2, "John's": 3, "01.2026": 4, "Лист_1": 5}


def outcome(module: types.ModuleType, script: str, *, read: bool) -> tuple[str, bool]:
    """Результат компиляции как сравнимая строка + признак «дошло до результата».

    Исключение — тоже результат (его текст обязан совпасть), но отдельно считаем долю
    успешных компиляций: если генератор кормит компилятор мусором, сравнение ошибок
    зелёное и ничего не проверяет.
    """
    try:
        if read:
            plan = module.compile_read(script, default_tab="Sheet1")
            value = {"values": plan.values, "meta": plan.meta}
        else:
            value = module.compile_update(
                module.parse_update_script(script), SHEET_IDS, default_tab="Sheet1"
            )
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str), True
    except Exception as e:  # исключение эталона обязано совпасть с новым — тоже результат
        return f"{type(e).__name__}: {e}", False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD", help="git-ревизия эталона (default: HEAD)")
    parser.add_argument("--count", type=int, default=20000, help="сколько скриптов сгенерировать")
    parser.add_argument("--seed", type=int, default=20260723, help="seed генератора")
    parser.add_argument("--show", type=int, default=5, help="сколько расхождений напечатать")
    args = parser.parse_args()

    sys.path.insert(0, "src")
    from mpu.lib import sheet_batch as current

    reference = load_reference(args.ref)
    rnd = random.Random(args.seed)

    mismatches: list[tuple[str, str, str, bool]] = []
    compiled = 0
    for i in range(args.count):
        read = i % 4 == 0
        script = generate(rnd, READ_VERBS if read else VERBS)
        got, got_ok = outcome(current, script, read=read)
        want, _ = outcome(reference, script, read=read)
        compiled += got_ok
        if got != want:
            mismatches.append((script, want, got, read))

    share = compiled / args.count if args.count else 0.0
    mode = f"{args.count} скриптов, эталон {args.ref}, из них скомпилировалось {share:.0%}"
    if share < MIN_COMPILED_SHARE:
        print(
            f"⚠️  только {share:.0%} входов дошли до результата — сравниваются в основном "
            f"тексты ошибок; проверь генератор перед тем, как доверять зелёному прогону"
        )
    if not mismatches:
        print(f"{'✅' if share >= MIN_COMPILED_SHARE else '⚠️ '} расхождений нет ({mode})")
        return 0 if share >= MIN_COMPILED_SHARE else 2
    print(f"❌ расхождений: {len(mismatches)} из {args.count} ({mode})")
    for script, want, got, read in mismatches[: args.show]:
        print(f"\n--- {'compile_read' if read else 'compile_update'} ---\nвход:\n{script}")
        print(f"эталон: {want[:300]}\nтекущий: {got[:300]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
