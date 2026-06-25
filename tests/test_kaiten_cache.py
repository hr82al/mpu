"""Тесты `lib/kaiten_cache.py` — discover/store-функции, тонкие ридеры кэша и
чистые хелперы `filter_refs`/`resolve_ref`.

Сеть и Kaiten мокаются на именованных швах: `KaitenClient.from_env` подменяется
фейком (фикстуры в памяти), `env.get` — на наличие/отсутствие `KITEN_API_KEY`,
`store.DB_PATH` — на временную SQLite-БД (через `bootstrap_db`/прямой `store`).
Реального I/O нет.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from urllib.error import URLError

import pytest

from mpu.lib import env, kaiten_cache, store
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenBoard,
    KaitenColumn,
    KaitenCustomProperty,
    KaitenLane,
    KaitenSpace,
)
from mpu.lib.kaiten_cache import (
    cached_boards,
    cached_columns,
    cached_custom_properties,
    cached_lanes,
    cached_spaces,
    discover_and_store,
    discover_columns_and_store,
    discover_custom_properties_and_store,
    discover_lanes_and_store,
    filter_refs,
    property_names,
    resolve_ref,
)

# ── Фейк Kaiten-клиента + установка швов ────────────────────────────────────────


class _FakeKaitenClient:
    """Фейк `KaitenClient`: возвращает фиксированные фикстуры, считает вызовы.

    Любой list_* при заданном `raises` бросает это исключение (для error-веток
    discover-функций). `*_calls` — журнал аргументов для проверки short-circuit.
    """

    def __init__(
        self,
        *,
        spaces: list[KaitenSpace] | None = None,
        boards: list[KaitenBoard] | None = None,
        lanes: list[KaitenLane] | None = None,
        columns: list[KaitenColumn] | None = None,
        properties: list[KaitenCustomProperty] | None = None,
        raises: Exception | None = None,
    ) -> None:
        self._spaces = spaces or []
        self._boards = boards or []
        self._lanes = lanes or []
        self._columns = columns or []
        self._properties = properties or []
        self._raises = raises
        self.space_calls = 0
        self.property_calls = 0
        self.lane_calls: list[list[int]] = []
        self.column_calls: list[list[int]] = []

    def list_spaces(self) -> tuple[list[KaitenSpace], list[KaitenBoard]]:
        self.space_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._spaces, self._boards

    def list_lanes(self, board_ids: list[int]) -> list[KaitenLane]:
        self.lane_calls.append(board_ids)
        if self._raises is not None:
            raise self._raises
        return self._lanes

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        self.column_calls.append(board_ids)
        if self._raises is not None:
            raise self._raises
        return self._columns

    def list_custom_properties(self) -> list[KaitenCustomProperty]:
        self.property_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._properties


def _set_key(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    """Подменить `env.get` так, что `KITEN_API_KEY` == value (None ⇒ не задан)."""

    def _get(name: str, default: str | None = None) -> str | None:
        return value if name == "KITEN_API_KEY" else default

    monkeypatch.setattr(env, "get", _get)


def _install_client(monkeypatch: pytest.MonkeyPatch, fake: _FakeKaitenClient) -> None:
    """Подменить `KaitenClient.from_env()` так, что он возвращает фейк."""

    class _Stub:
        @staticmethod
        def from_env() -> _FakeKaitenClient:
            return fake

    monkeypatch.setattr(kaiten_cache, "KaitenClient", _Stub)


@pytest.fixture
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Временный путь `mpu.db` + redirect `store.DB_PATH` (БЕЗ bootstrap)."""
    path = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", path)
    return path


# ── фабрики фикстур-датаклассов (без shadowing builtins) ────────────────────────


def _space(space_id: int, title: str, *, archived: bool = False) -> KaitenSpace:
    return KaitenSpace(id=space_id, title=title, archived=archived)


def _board(board_id: int, space_id: int, title: str) -> KaitenBoard:
    return KaitenBoard(id=board_id, space_id=space_id, title=title)


def _lane(lane_id: int, board_id: int, title: str) -> KaitenLane:
    return KaitenLane(id=lane_id, board_id=board_id, title=title)


def _column(column_id: int, board_id: int, title: str) -> KaitenColumn:
    return KaitenColumn(id=column_id, board_id=board_id, title=title)


def _prop(prop_id: int, name: str, ptype: str | None = "string") -> KaitenCustomProperty:
    return KaitenCustomProperty(id=prop_id, name=name, type=ptype)


_CLIENT_ERRORS: list[Exception] = [
    KaitenAPIError("GET", "/spaces", 500, "boom"),
    URLError("connection refused"),
    OSError("disk"),
]


# ── discover_and_store ──────────────────────────────────────────────────────────


def test_discover_and_store_no_api_key(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, None)
    fake = _FakeKaitenClient(spaces=[_space(1, "S")])
    _install_client(monkeypatch, fake)

    result = discover_and_store()

    assert result.spaces == []
    assert result.boards == []
    assert result.error == "KITEN_API_KEY не задан"
    assert fake.space_calls == 0  # ранний выход — клиент не дёргается


@pytest.mark.parametrize("exc", _CLIENT_ERRORS)
def test_discover_and_store_client_error(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(raises=exc))

    result = discover_and_store()

    assert result.spaces == []
    assert result.boards == []
    assert result.error is not None
    assert result.error.startswith("kaiten:")


def test_discover_and_store_happy_writes_rows(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    spaces = [_space(10, "Support"), _space(20, "Archive", archived=True)]
    boards = [_board(100, 10, "Board A"), _board(101, 10, "Board B")]
    _install_client(monkeypatch, _FakeKaitenClient(spaces=spaces, boards=boards))

    result = discover_and_store()

    assert result.error is None
    assert result.spaces == spaces
    assert result.boards == boards

    with store.store(db_path) as conn:
        srows = conn.execute("SELECT id, title, archived FROM kaiten_spaces ORDER BY id").fetchall()
        brows = conn.execute("SELECT id, space_id, title FROM kaiten_boards ORDER BY id").fetchall()
    assert [(r["id"], r["title"], r["archived"]) for r in srows] == [
        (10, "Support", 0),
        (20, "Archive", 1),
    ]
    assert [(r["id"], r["space_id"], r["title"]) for r in brows] == [
        (100, 10, "Board A"),
        (101, 10, "Board B"),
    ]


def test_discover_and_store_idempotent_replaces(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Повторный запуск — DELETE+INSERT: остаётся только последний набор."""
    _set_key(monkeypatch, "tok")
    _install_client(
        monkeypatch,
        _FakeKaitenClient(spaces=[_space(1, "A"), _space(2, "B")], boards=[_board(9, 1, "Old")]),
    )
    discover_and_store()
    # второй прогон с другим набором
    _install_client(
        monkeypatch,
        _FakeKaitenClient(spaces=[_space(2, "B2"), _space(3, "C")], boards=[_board(8, 3, "New")]),
    )
    discover_and_store()

    assert cached_spaces() == [(2, "B2"), (3, "C")]
    assert cached_boards() == [(8, "New")]


# ── discover_lanes_and_store ────────────────────────────────────────────────────


def test_discover_lanes_no_api_key(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, None)
    fake = _FakeKaitenClient(lanes=[_lane(1, 7, "L")])
    _install_client(monkeypatch, fake)

    result = discover_lanes_and_store([7])

    assert result.lanes == []
    assert result.error == "KITEN_API_KEY не задан"
    assert fake.lane_calls == []


def test_discover_lanes_empty_board_ids_short_circuit(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    fake = _FakeKaitenClient(lanes=[_lane(1, 7, "L")])
    _install_client(monkeypatch, fake)

    result = discover_lanes_and_store([])

    assert result.lanes == []
    assert result.error is None
    assert fake.lane_calls == []  # пустой список досок — клиент не дёргается


@pytest.mark.parametrize("exc", _CLIENT_ERRORS)
def test_discover_lanes_client_error(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(raises=exc))

    result = discover_lanes_and_store([7])

    assert result.lanes == []
    assert result.error is not None
    assert result.error.startswith("kaiten:")


def test_discover_lanes_happy_writes_rows(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "tok")
    lanes = [_lane(844615, 7, "Support"), _lane(844616, 7, "Backlog")]
    _install_client(monkeypatch, _FakeKaitenClient(lanes=lanes))

    result = discover_lanes_and_store([7])

    assert result.error is None
    assert result.lanes == lanes
    assert cached_lanes(7) == [(844616, "Backlog"), (844615, "Support")]


def test_discover_lanes_scoped_delete_preserves_other_boards(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, bootstrap_db: Callable[[Path | str], None]
) -> None:
    """DELETE+INSERT скоупится по board_ids — кэш других досок не стирается."""
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.execute(
            "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            (5, 999, "Чужая доска", 1),
        )

    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(lanes=[_lane(11, 7, "Новая")]))
    discover_lanes_and_store([7])

    assert cached_lanes(7) == [(11, "Новая")]
    assert cached_lanes(999) == [(5, "Чужая доска")]  # не затёрто


def test_discover_lanes_multi_board_placeholders(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    fake = _FakeKaitenClient(lanes=[_lane(1, 7, "A"), _lane(2, 8, "B")])
    _install_client(monkeypatch, fake)

    result = discover_lanes_and_store([7, 8])

    assert result.error is None
    assert fake.lane_calls == [[7, 8]]
    assert cached_lanes() == [(1, "A"), (2, "B")]


# ── discover_columns_and_store ──────────────────────────────────────────────────


def test_discover_columns_no_api_key(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, None)
    fake = _FakeKaitenClient(columns=[_column(1, 7, "C")])
    _install_client(monkeypatch, fake)

    result = discover_columns_and_store([7])

    assert result.columns == []
    assert result.error == "KITEN_API_KEY не задан"
    assert fake.column_calls == []


def test_discover_columns_empty_board_ids_short_circuit(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    fake = _FakeKaitenClient(columns=[_column(1, 7, "C")])
    _install_client(monkeypatch, fake)

    result = discover_columns_and_store([])

    assert result.columns == []
    assert result.error is None
    assert fake.column_calls == []


@pytest.mark.parametrize("exc", _CLIENT_ERRORS)
def test_discover_columns_client_error(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(raises=exc))

    result = discover_columns_and_store([7])

    assert result.columns == []
    assert result.error is not None
    assert result.error.startswith("kaiten:")


def test_discover_columns_happy_writes_rows(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "tok")
    columns = [_column(2417329, 7, "Готово"), _column(2417330, 7, "В работе")]
    _install_client(monkeypatch, _FakeKaitenClient(columns=columns))

    result = discover_columns_and_store([7])

    assert result.error is None
    assert result.columns == columns
    # cached_columns сортирует по title: «В работе» (В) < «Готово» (Г).
    assert cached_columns(7) == [(2417330, "В работе"), (2417329, "Готово")]


def test_discover_columns_scoped_delete_preserves_other_boards(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.execute(
            "INSERT INTO kaiten_columns (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            (5, 999, "Чужая колонка", 1),
        )

    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(columns=[_column(11, 7, "Новая")]))
    discover_columns_and_store([7])

    assert cached_columns(7) == [(11, "Новая")]
    assert cached_columns(999) == [(5, "Чужая колонка")]


# ── discover_custom_properties_and_store ────────────────────────────────────────


def test_discover_custom_properties_no_api_key(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, None)
    fake = _FakeKaitenClient(properties=[_prop(1, "X")])
    _install_client(monkeypatch, fake)

    result = discover_custom_properties_and_store()

    assert result.properties == []
    assert result.error == "KITEN_API_KEY не задан"
    assert fake.property_calls == 0


@pytest.mark.parametrize("exc", _CLIENT_ERRORS)
def test_discover_custom_properties_client_error(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(raises=exc))

    result = discover_custom_properties_and_store()

    assert result.properties == []
    assert result.error is not None
    assert result.error.startswith("kaiten:")


def test_discover_custom_properties_happy_writes_rows(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    props = [_prop(542506, "Описание", "string"), _prop(398965, "Ссылка на PR", None)]
    _install_client(monkeypatch, _FakeKaitenClient(properties=props))

    result = discover_custom_properties_and_store()

    assert result.error is None
    assert result.properties == props
    with store.store(db_path) as conn:
        rows = conn.execute(
            "SELECT id, name, type FROM kaiten_custom_properties ORDER BY id"
        ).fetchall()
    assert [(r["id"], r["name"], r["type"]) for r in rows] == [
        (398965, "Ссылка на PR", None),
        (542506, "Описание", "string"),
    ]


def test_discover_custom_properties_idempotent_replaces(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    _install_client(monkeypatch, _FakeKaitenClient(properties=[_prop(1, "Old")]))
    discover_custom_properties_and_store()
    _install_client(monkeypatch, _FakeKaitenClient(properties=[_prop(2, "New")]))
    discover_custom_properties_and_store()

    assert cached_custom_properties() == {2: "New"}


# ── тонкие ридеры кэша: пустой/отсутствующий кэш → [] / {} ───────────────────────


def test_cached_readers_missing_tables_return_empty(db_path: Path) -> None:
    # БД без bootstrap — таблиц нет, sqlite3.Error глотается, ридеры отдают пусто.
    assert cached_spaces() == []
    assert cached_boards() == []
    assert cached_boards(5) == []
    assert cached_lanes() == []
    assert cached_lanes(5) == []
    assert cached_columns() == []
    assert cached_columns(5) == []
    assert cached_custom_properties() == {}


def test_cached_spaces_orders_active_first(
    db_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.executemany(
            "INSERT INTO kaiten_spaces (id, title, archived, discovered_at) VALUES (?, ?, ?, ?)",
            [(1, "Zeta", 0, 1), (2, "Alpha", 1, 1), (3, "Beta", 0, 1)],
        )
    # archived ASC, затем title — активные (Beta, Zeta) перед архивным Alpha.
    assert cached_spaces() == [(3, "Beta"), (1, "Zeta"), (2, "Alpha")]


def test_cached_boards_filter_by_space(
    db_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.executemany(
            "INSERT INTO kaiten_boards (id, space_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(10, 1, "Boo", 1), (11, 2, "Aaa", 1), (12, 1, "Zzz", 1)],
        )
    assert cached_boards() == [(11, "Aaa"), (10, "Boo"), (12, "Zzz")]  # все, по title
    assert cached_boards(1) == [(10, "Boo"), (12, "Zzz")]  # только space 1


def test_cached_lanes_filter_by_board(
    db_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.executemany(
            "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(10, 7, "Beta", 1), (11, 8, "Other", 1), (12, 7, "Alpha", 1)],
        )
    assert cached_lanes() == [(12, "Alpha"), (10, "Beta"), (11, "Other")]
    assert cached_lanes(7) == [(12, "Alpha"), (10, "Beta")]


def test_cached_columns_filter_by_board(
    db_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.executemany(
            "INSERT INTO kaiten_columns (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
            [(10, 7, "Beta", 1), (11, 8, "Other", 1), (12, 7, "Alpha", 1)],
        )
    assert cached_columns() == [(12, "Alpha"), (10, "Beta"), (11, "Other")]
    assert cached_columns(7) == [(12, "Alpha"), (10, "Beta")]


def test_cached_custom_properties_returns_id_name_map(
    db_path: Path, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.executemany(
            "INSERT INTO kaiten_custom_properties (id, name, type, discovered_at) "
            "VALUES (?, ?, ?, ?)",
            [(1, "Гипотеза", "string", 1), (2, "Результат", None, 1)],
        )
    assert cached_custom_properties() == {1: "Гипотеза", 2: "Результат"}


# ── property_names: lazy-populate из сети при холодном кэше ──────────────────────


def test_property_names_returns_cache_without_network(
    db_path: Path, monkeypatch: pytest.MonkeyPatch, bootstrap_db: Callable[[Path | str], None]
) -> None:
    bootstrap_db(db_path)
    with store.store(db_path) as conn, conn:
        conn.execute(
            "INSERT INTO kaiten_custom_properties (id, name, type, discovered_at) "
            "VALUES (?, ?, ?, ?)",
            (1, "Из кэша", "string", 1),
        )
    _set_key(monkeypatch, "tok")
    fake = _FakeKaitenClient(properties=[_prop(2, "Из сети")])
    _install_client(monkeypatch, fake)

    assert property_names() == {1: "Из кэша"}
    assert fake.property_calls == 0  # тёплый кэш — без сетевого запроса


def test_property_names_lazy_populates_on_cold_cache(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(monkeypatch, "tok")
    fake = _FakeKaitenClient(properties=[_prop(542506, "Описание")])
    _install_client(monkeypatch, fake)

    assert property_names() == {542506: "Описание"}
    assert fake.property_calls == 1  # холодный кэш → один запрос


def test_property_names_cold_cache_no_key_returns_empty(
    db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # холодный кэш + нет ключа: discover молча провалится, остаётся {} (best-effort).
    _set_key(monkeypatch, None)
    fake = _FakeKaitenClient(properties=[_prop(1, "X")])
    _install_client(monkeypatch, fake)

    assert property_names() == {}
    assert fake.property_calls == 0


# ── filter_refs (completion: ID-префикс / подстрока title / strip) ──────────────

_REF_ROWS: list[tuple[int, str]] = [
    (286794, "10Х Support"),
    (286791, "Naparad WB"),
    (368441, "Keris WB"),
]


def test_filter_refs_id_prefix() -> None:
    assert filter_refs("2867", _REF_ROWS) == [("286794", "10Х Support"), ("286791", "Naparad WB")]


def test_filter_refs_title_substring_casefold() -> None:
    assert filter_refs("wb", _REF_ROWS) == [("286791", "Naparad WB"), ("368441", "Keris WB")]


def test_filter_refs_strips_and_empty_returns_all() -> None:
    # whitespace-only → пустой needle → все строки.
    assert filter_refs("   ", _REF_ROWS) == [
        ("286794", "10Х Support"),
        ("286791", "Naparad WB"),
        ("368441", "Keris WB"),
    ]
    # окружающие пробелы обрезаются перед матчем.
    assert filter_refs("  keris  ", _REF_ROWS) == [("368441", "Keris WB")]


def test_filter_refs_no_match_excludes_row() -> None:
    assert filter_refs("zzz", _REF_ROWS) == []


# ── resolve_ref (ID или подстрока названия → int; коллизии → ValueError) ─────────


def test_resolve_ref_numeric_passthrough_empty_rows() -> None:
    assert resolve_ref("99999", [], kind="space") == 99999


def test_resolve_ref_numeric_strips_whitespace() -> None:
    assert resolve_ref("  286791  ", _REF_ROWS, kind="space") == 286791


def test_resolve_ref_exact_title_wins_over_substring() -> None:
    rows = [(1, "Готово к ревью"), (2, "Готово")]
    assert resolve_ref("готово", rows, kind="column") == 2


def test_resolve_ref_unique_substring() -> None:
    assert resolve_ref("Naparad", _REF_ROWS, kind="space") == 286791


def test_resolve_ref_no_match_raises() -> None:
    with pytest.raises(ValueError, match="не найден"):
        resolve_ref("Nonexistent", _REF_ROWS, kind="space")


def test_resolve_ref_ambiguous_lists_candidates() -> None:
    with pytest.raises(ValueError, match="неоднозначен") as exc:
        resolve_ref("WB", _REF_ROWS, kind="space")
    assert "286791" in str(exc.value)
    assert "368441" in str(exc.value)
