"""Защита `mpu sql` от модифицирующих/разрушающих запросов.

При `PROTECT=true` (default) в ~/.config/mpu/.env разрешены только read-only
statement'ы (SELECT/UNION/EXPLAIN/SHOW/...). Любой INSERT/UPDATE/DELETE/MERGE/
DROP/TRUNCATE/CREATE/ALTER/COPY/GRANT блокируется, в том числе спрятанный в
data-modifying CTE (`WITH x AS (INSERT ...) SELECT ...`) или под
`EXPLAIN ANALYZE <DML>` (в PostgreSQL такой EXPLAIN реально выполняет запрос).
Снять защиту: только `PROTECT=false` в .env (та же семантика, что у `mpu sheet set`).

Ограничение: статический анализ не ловит сайд-эффекты функций
(`SELECT pg_terminate_backend(...)`, `SELECT some_writing_func()`) — это вне
рамок проверки по типу statement'а.
"""

# pyright: reportPrivateImportUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportArgumentType=false
from __future__ import annotations

import logging

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from mpu.lib import env

# sqlglot шлёт WARNING "contains unsupported syntax. Falling back to ... 'Command'"
# на каждом EXPLAIN/SHOW — для guard'а это ожидаемый путь, шум на разрешённых запросах.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

_FALSEY = ("false", "0", "no", "off")

# Узлы, которые пишут/меняют данные или схему. Любой такой узел в дереве —
# включая вложенный в CTE/подзапрос — означает блок.
_WRITE_NODE_NAMES = (
    "Insert",
    "Update",
    "Delete",
    "Merge",
    "Create",
    "Drop",
    "Alter",
    "AlterTable",
    "AlterColumn",
    "TruncateTable",
    "Truncate",
    "Copy",
    "Grant",
)
_WRITE_NODES = tuple(getattr(exp, n) for n in _WRITE_NODE_NAMES if hasattr(exp, n))

# Допустимые top-level read-only типы. EXPLAIN/SHOW приходят как `exp.Command`
# (generic fallback) и обрабатываются отдельно в `_check_command`.
_READ_TOP_NAMES = ("Select", "Union", "Subquery", "Describe", "Show", "Pragma")
_READ_TOP = tuple(getattr(exp, n) for n in _READ_TOP_NAMES if hasattr(exp, n))

_HINT = "Сними защиту: `PROTECT=false` в ~/.config/mpu/.env."


def _blocked_msg(kind: str) -> str:
    return f"заблокировано: {kind.upper()} — не read-only. {_HINT}"


class SqlGuardError(Exception):
    """SQL заблокирован guard'ом (содержит модифицирующий statement или не парсится)."""


def is_protected() -> bool:
    """Защита включена, если `protect`/`PROTECT` не задано или не falsey.

    Зеркалит `mpu sheet`-логику: не задано → защита включена;
    `false`/`0`/`no`/`off` → защита снята.
    """
    raw = env.get("protect") or env.get("PROTECT")
    return raw is None or raw.strip().lower() not in _FALSEY


def check_read_only(sql: str) -> None:
    """Бросить `SqlGuardError`, если SQL содержит не read-only statement.

    Multi-statement (`a; b`) проверяется целиком — блок, если хоть один не read-only.
    Если sqlglot не смог разобрать SQL — блокируем (консервативно).
    """
    try:
        statements = sqlglot.parse(sql, dialect="postgres")
    except ParseError as e:
        raise SqlGuardError(f"не удалось разобрать SQL, запрос заблокирован: {e}") from e

    statements = [s for s in statements if s is not None]
    if not statements:
        raise SqlGuardError("пустой или неразобранный SQL заблокирован")

    for stmt in statements:
        _check_statement(stmt)


def _check_statement(stmt: exp.Expression) -> None:
    if isinstance(stmt, exp.Command):
        _check_command(stmt)
        return

    # Любой пишущий узел в дереве (прямой DML/DDL или data-modifying CTE) → блок.
    for node in stmt.walk():
        if isinstance(node, _WRITE_NODES):
            raise SqlGuardError(_blocked_msg(type(node).__name__))

    if not isinstance(stmt, _READ_TOP):
        raise SqlGuardError(_blocked_msg(type(stmt).__name__))


def _check_command(cmd: exp.Command) -> None:
    """`exp.Command` — generic fallback для нераспознанного синтаксиса (EXPLAIN/SHOW/VACUUM/...).

    Разрешаем только SHOW и EXPLAIN; для EXPLAIN вытаскиваем вложенный запрос и
    рекурсивно проверяем (`EXPLAIN ANALYZE DELETE ...` выполняет DELETE — блок).
    """
    keyword = (cmd.this or "").strip().upper()
    if keyword == "SHOW":
        return
    if keyword == "EXPLAIN":
        inner = _strip_explain_options(cmd)
        if not inner.strip():
            raise SqlGuardError(f"заблокировано: EXPLAIN без вложенного запроса. {_HINT}")
        check_read_only(inner)
        return
    raise SqlGuardError(_blocked_msg(keyword or "неизвестная команда"))


def _strip_explain_options(cmd: exp.Command) -> str:
    """Вернуть вложенный запрос из EXPLAIN, отбросив опции.

    `EXPLAIN (ANALYZE, ...) <stmt>` или `EXPLAIN ANALYZE VERBOSE <stmt>`.
    `cmd.args["expression"]` — Literal с остатком текста после `EXPLAIN`.
    """
    expr = cmd.args.get("expression")
    remainder = expr.this if isinstance(expr, exp.Literal) else ""
    s = str(remainder).strip()

    if s.startswith("("):
        depth = 0
        for i, ch in enumerate(s):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return s[i + 1 :].strip()
        raise SqlGuardError(f"заблокировано: EXPLAIN с несбалансированными скобками. {_HINT}")

    bare_options = ("analyze", "verbose", "true", "false", "on", "off")
    tokens = s.split()
    idx = 0
    while idx < len(tokens) and tokens[idx].lower() in bare_options:
        idx += 1
    return " ".join(tokens[idx:])
