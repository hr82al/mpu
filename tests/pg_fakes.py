"""Фейки PG-протокола для тестов `pg_copy` / `copy-client` / `copy-dev`.

`_RichConn` ду(к)-типизирует `pg.PgConn`: атрибуты для argv (`host`/`port`/…) + `.connect()`
с полным psycopg-протоколом курсора/COPY (execute/fetchone/fetchall/copy/commit/rowcount).
`_FakePopen` подменяет `subprocess.Popen` в `run_pg_tool` (стрим строк + код возврата +
heartbeat-таймауты). Не `test_`-модуль — pytest его не собирает, только импортируют тесты.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterator

import pytest

from mpu.lib import pg_copy

# Лог вызовов курсора: ("execute", тип) | ("copy", тип) | ("commit", "") | ("write", repr)
LogRow = tuple[str, ...]


class FakePopen:
    """Подмена `subprocess.Popen`: отдаёт строки прогресса и заданный код возврата.

    `timeouts` штук первых `wait()` бросают `TimeoutExpired` (ветка heartbeat),
    затем возвращается `rc`.
    """

    def __init__(self, *, lines: list[str], rc: int, timeouts: int) -> None:
        self.stdout: list[str] = list(lines)
        self._rc = rc
        self._timeouts_left = timeouts

    def wait(self, timeout: float | None = None) -> int:
        if self._timeouts_left > 0:
            self._timeouts_left -= 1
            raise subprocess.TimeoutExpired(cmd="pg", timeout=timeout or 0.0)
        return self._rc


class RichCopy:
    """COPY-объект psycopg: и читается (итерация блоков, COPY TO), и пишется (COPY FROM)."""

    def __init__(self, blocks: list[bytes], log: list[LogRow]) -> None:
        self._blocks = blocks
        self._log = log

    def __enter__(self) -> RichCopy:
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._blocks)

    def write(self, block: bytes) -> None:
        self._log.append(("write", repr(block)))


class RichCursor:
    def __init__(self, conn: RichConn) -> None:
        self._conn = conn
        self.rowcount = conn.rowcount

    def __enter__(self) -> RichCursor:
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def execute(self, query: object, params: object = None) -> None:
        self._conn.log.append(("execute", type(query).__name__))

    def fetchone(self) -> tuple[object, ...] | None:
        if self._conn.fetchone_seq is not None:
            if self._conn.fetchone_seq:
                return self._conn.fetchone_seq.pop(0)
            return None
        return self._conn.size_row

    def fetchall(self) -> list[tuple[str, ...]]:
        return self._conn.ss_rows

    def copy(self, query: object) -> RichCopy:
        self._conn.log.append(("copy", type(query).__name__))
        return RichCopy(self._conn.blocks, self._conn.log)


class RichDb:
    def __init__(self, conn: RichConn) -> None:
        self._conn = conn

    def __enter__(self) -> RichDb:
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def cursor(self) -> RichCursor:
        return RichCursor(self._conn)

    def commit(self) -> None:
        self._conn.log.append(("commit", ""))


class RichConn:
    """PgConn-подобный фейк: атрибуты для argv + `.connect()` с полным cursor/COPY-протоколом.

    - `ss_rows` — что вернёт `ss_ids` (fetchall);
    - `size_row` — что вернёт `schema_size`/`_schema_exists` (fetchone); `None` → пустой ответ;
    - `rowcount` — `cursor.rowcount` после COPY (отрицательный → «?» строк в выводе);
    - `raise_on_connect` — `.connect()` бросает (ветка best-effort `except`).
    """

    def __init__(
        self,
        host: str,
        *,
        dbname: str = "db",
        ss_rows: list[tuple[str, ...]] | None = None,
        size_row: tuple[object, ...] | None = (3, "1 MB"),
        fetchone_seq: list[tuple[object, ...] | None] | None = None,
        blocks: list[bytes] | None = None,
        rowcount: int = 2,
        raise_on_connect: bool = False,
    ) -> None:
        self.host = host
        self.port = "5432"
        self.user = "u"
        self.dbname = dbname
        self.password = "p"
        self.ss_rows: list[tuple[str, ...]] = ss_rows if ss_rows is not None else []
        self.size_row = size_row
        self.fetchone_seq = fetchone_seq
        self.blocks: list[bytes] = blocks if blocks is not None else [b"r\n"]
        self.rowcount = rowcount
        self.raise_on_connect = raise_on_connect
        self.log: list[LogRow] = []

    def connect(self, **_: object) -> RichDb:
        if self.raise_on_connect:
            raise RuntimeError("connect boom")
        return RichDb(self)


def patch_popen(
    mp: pytest.MonkeyPatch,
    *,
    rc: int = 0,
    lines: tuple[str, ...] = ("progress\n",),
    timeouts: int = 0,
) -> None:
    """Подменить `pg_copy.subprocess.Popen` фейком (где живёт `run_pg_tool`)."""

    def _make(argv: list[str], **_: object) -> FakePopen:
        return FakePopen(lines=list(lines), rc=rc, timeouts=timeouts)

    mp.setattr(pg_copy.subprocess, "Popen", _make)
