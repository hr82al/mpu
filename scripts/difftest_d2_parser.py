#!/usr/bin/env python
"""Дифференциальное сравнение `d2_parser` с эталонной git-ревизией.

Как `difftest_sheet_batch.py`, но для парсера d2-исходника: `parse_d2_source` пишет в Miro
(команда `d2-miro`), поэтому расхождение молча ломает диаграмму. Генерирует d2 по грамматике
из докстринга `parse_d2_source` (шейпы с лейблом, вложенные блоки, свойства, связи, md-блоки)
плюс подмешивает корпус из тестов, и сравнивает `(shapes, edges)` обеих реализаций.

    python scripts/difftest_d2_parser.py --ref HEAD --count 20000
"""

from __future__ import annotations

import argparse
import importlib.util
import random
import subprocess
import sys
import tempfile
import types
from pathlib import Path

MODULE_PATH = "src/mpu/lib/d2_parser.py"

NAMES = ["a", "b", "box", "node_1", "srcSvc", "db"]
LABELS = ['"label"', '"с пробелом"', '""', "plain", '"a: b"', '"с #хешем"']
SHAPES = ["cylinder", "rectangle", "person", "cloud", "queue"]
COLORS = ['"#EA4335"', '"#fff"', "#000"]

# Доли верхнеуровневых конструкций в генераторе.
_BLOCK_SHARE = 0.2
_COMMENT_SHARE = 0.3


def _shape(rnd: random.Random) -> str:
    name = rnd.choice(NAMES)
    forms = [
        lambda: f"{name}: {rnd.choice(LABELS)}",
        lambda: f"{name}: {rnd.choice(LABELS)} {{\n  shape: {rnd.choice(SHAPES)}\n}}",
        lambda: f"{name}.shape: {rnd.choice(SHAPES)}",
        lambda: f"{name}.style.fill: {rnd.choice(COLORS)}",
        lambda: f"{rnd.choice(NAMES)} -> {rnd.choice(NAMES)}: {rnd.choice(LABELS)}",
        lambda: f"{name}: |md\n# {rnd.choice(LABELS)}\nтекст\n|",
    ]
    return rnd.choice(forms)()


def _block(rnd: random.Random) -> str:
    inner = "\n".join("  " + _shape(rnd) for _ in range(rnd.randint(1, 3)))
    return f"{rnd.choice(NAMES)}: {rnd.choice(LABELS)} {{\n{inner}\n}}"


def generate(rnd: random.Random) -> str:
    """d2-скрипт из 1–6 верхнеуровневых конструкций, иногда с комментариями/пустыми строками."""
    parts: list[str] = []
    for _ in range(rnd.randint(1, 6)):
        if rnd.random() < _BLOCK_SHARE:
            parts.append(_block(rnd))
        else:
            parts.append(_shape(rnd))
        if rnd.random() < _COMMENT_SHARE:
            parts.append("# comment")
    return "\n".join(parts)


def load_reference(rev: str) -> types.ModuleType:
    blob = subprocess.run(
        ["git", "show", f"{rev}:{MODULE_PATH}"], capture_output=True, text=True, check=True
    ).stdout
    tmp = Path(tempfile.mkdtemp()) / "d2_parser_reference.py"
    tmp.write_text(blob, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("d2_parser_reference", tmp)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["d2_parser_reference"] = module
    spec.loader.exec_module(module)
    return module


def outcome(module: types.ModuleType, text: str) -> str:
    """`(shapes, edges)` как сравнимая строка; исключение — тоже результат."""
    try:
        shapes, edges = module.parse_d2_source(text)
        parts = [f"{k}={v}" for k, v in sorted(shapes.items())]
        parts += [f"edge {e}" for e in edges]
        return "\n".join(parts)
    except Exception as e:  # исключение эталона обязано совпасть с новым
        return f"{type(e).__name__}: {e}"


def _corpus() -> list[str]:
    """d2-фрагменты из тестов (реальные примеры вдобавок к генератору)."""
    import ast

    out: list[str] = []
    for f in ("tests/test_d2_parser.py", "tests/test_d2_miro.py"):
        src = Path(f).read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                v = node.value
                if ("->" in v or (":" in v and "\n" in v) or "|md" in v) and "<svg" not in v:
                    out.append(v)
    return sorted(set(out))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--count", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=20260723)
    parser.add_argument("--show", type=int, default=5)
    args = parser.parse_args()

    sys.path.insert(0, "src")
    from mpu.lib import d2_parser as current

    reference = load_reference(args.ref)
    rnd = random.Random(args.seed)

    scripts = _corpus() + [generate(rnd) for _ in range(args.count)]
    mismatches = [
        (s, want, got)
        for s in scripts
        if (got := outcome(current, s)) != (want := outcome(reference, s))
    ]
    mode = f"{len(scripts)} скриптов (+{len(_corpus())} из тестов), эталон {args.ref}"
    if not mismatches:
        print(f"✅ расхождений нет ({mode})")
        return 0
    print(f"❌ расхождений: {len(mismatches)} из {len(scripts)} ({mode})")
    for s, want, got in mismatches[: args.show]:
        print(f"\n--- вход ---\n{s}\nэталон: {want[:300]}\nтекущий: {got[:300]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
