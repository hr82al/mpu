"""Тесты `lib/sql_guard` — read-only allowlist и чтение PROTECT-флага."""

import pytest

from mpu.lib import env, sql_guard

_BLOCKED = [
    "INSERT INTO wb_cards (nm_id) VALUES (1)",
    "UPDATE wb_cards SET nm_id = 2 WHERE nm_id = 1",
    "DELETE FROM wb_cards",
    "DROP TABLE wb_cards",
    "TRUNCATE wb_cards",
    "CREATE TABLE t (id int)",
    "ALTER TABLE wb_cards ADD COLUMN x int",
    "COPY wb_cards TO '/tmp/x.csv'",
    "GRANT SELECT ON wb_cards TO someone",
    "SELECT 1; DROP TABLE wb_cards",
    "WITH c AS (SELECT 1) DELETE FROM wb_cards",
    # data-modifying CTE: top-level Select, но внутри Insert/Delete → пишет данные
    "WITH x AS (INSERT INTO wb_cards (nm_id) VALUES (1) RETURNING *) SELECT * FROM x",
    "WITH x AS (DELETE FROM wb_cards RETURNING *) SELECT * FROM x",
    # EXPLAIN ANALYZE <DML> в PostgreSQL реально выполняет DML
    "EXPLAIN ANALYZE DELETE FROM wb_cards",
    "EXPLAIN (ANALYZE) UPDATE wb_cards SET nm_id = 2",
    "EXPLAIN ANALYZE INSERT INTO wb_cards (nm_id) VALUES (1)",
    # прочий нераспознанный fallback (Command) — не read-only
    "VACUUM wb_cards",
    "CALL some_proc()",
    "SET search_path TO public",
]

_ALLOWED = [
    "SELECT 1",
    "SELECT * FROM wb_cards LIMIT 5",
    "EXPLAIN SELECT * FROM wb_cards",
    "EXPLAIN ANALYZE SELECT * FROM wb_cards",
    "SHOW search_path",
    "WITH c AS (SELECT 1) SELECT * FROM c",
    "SELECT 1 UNION SELECT 2",
    "SELECT 1; SELECT 2",
]


@pytest.mark.parametrize("sql", _BLOCKED)
def test_blocked_statements_raise(sql: str) -> None:
    with pytest.raises(sql_guard.SqlGuardError):
        sql_guard.check_read_only(sql)


@pytest.mark.parametrize("sql", _ALLOWED)
def test_allowed_statements_pass(sql: str) -> None:
    sql_guard.check_read_only(sql)


def test_unparseable_sql_blocked() -> None:
    with pytest.raises(sql_guard.SqlGuardError):
        sql_guard.check_read_only("THIS IS NOT SQL ;;;; (((")


def test_empty_sql_blocked() -> None:
    with pytest.raises(sql_guard.SqlGuardError):
        sql_guard.check_read_only("   ")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, True),
        ("true", True),
        ("1", True),
        ("yes", True),
        ("anything", True),
        ("false", False),
        ("FALSE", False),
        ("0", False),
        ("no", False),
        ("off", False),
        (" off ", False),
    ],
)
def test_is_protected(value: str | None, expected: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    def _get(name: str, default: str | None = None) -> str | None:
        if name in ("protect", "PROTECT"):
            return value
        return default

    monkeypatch.setattr(env, "get", _get)
    assert sql_guard.is_protected() is expected
