"""Тесты `mpu iu-wb`: get-source-data / make-sql / fix-formulas (`commands/iu_wb.py`).

Мокаем только seams: `resolve_server` (в `cli_wrap`, источник `resolve_selector`),
`pg.connect_to` + курсор (fake), `WebappClient.from_env`/`batch_get` (fake),
`servers.sl_ip`/`env_value` и `copy_to_clipboard` для ssh/clipboard. Сеть/PG/ssh/процессы
не задействованы — всё детерминированно.
"""

# Тестируем приватные хелперы модуля (`_client_id`, `_check_date`,
# `_resolve_subjects_and_targets`, `_read_unit_formulas`) напрямую — отсюда обращение
# к underscore-членам (как в test_iu_sql.py / test_cli_wrap.py).
# pyright: reportPrivateUsage=false

from __future__ import annotations

import datetime
import json
from typing import Any

import psycopg
import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import iu_wb
from mpu.lib import cli_wrap, pg, servers
from mpu.lib.resolver import ResolveError
from mpu.lib.sheet_api import SheetApiError

runner = CliRunner()


# ── фейки и хелперы ──────────────────────────────────────────────────────────


def _cand(
    *, client_id: int | None = None, spreadsheet_id: str | None = None, server: str = "sl-2"
) -> dict[str, object]:
    """Кандидат резолва с типом `dict[str, object]` (инвариантность списка в pyright)."""
    c: dict[str, object] = {"server": server}
    if client_id is not None:
        c["client_id"] = client_id
    if spreadsheet_id is not None:
        c["spreadsheet_id"] = spreadsheet_id
    return c


def _patch_resolve(
    monkeypatch: pytest.MonkeyPatch, *, server: int, candidates: list[dict[str, object]]
) -> None:
    """Подменить `cli_wrap.resolve_server` (call-site `resolve_selector`) фиксированным резолвом."""

    def _fake(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = (value, server_override)
        return server, candidates

    monkeypatch.setattr(cli_wrap, "resolve_server", _fake)


def _sl_ip(_n: int) -> str | None:
    return "192.168.150.92"


def _env_value(k: str) -> str | None:
    return "hr82al" if k == "PG_MY_USER_NAME" else None


def _noop_copy(_t: str) -> bool:
    return True


def _patch_ssh_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Заполнить sl_ip / PG_MY_USER_NAME / clipboard для ssh-обёртки `--print`."""
    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)


class _FakeCursor:
    """Курсор: запоминает execute(), отдаёт `results` по одному набору на каждый fetchall()."""

    def __init__(
        self, results: list[list[tuple[Any, ...]]], *, raise_on_execute: Exception | None = None
    ) -> None:
        self._results = list(results)
        self._raise = raise_on_execute
        self.executed: list[Any] = []

    def execute(self, query: Any, params: Any = None) -> None:
        _ = params
        self.executed.append(query)
        if self._raise is not None:
            raise self._raise

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._results.pop(0)

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _FakeConn:
    def __init__(self, cur: _FakeCursor) -> None:
        self.cur = cur
        self.closed = False

    def cursor(self) -> _FakeCursor:
        return self.cur

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> _FakeConn:
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _conn(
    *result_sets: list[tuple[Any, ...]], raise_on_execute: Exception | None = None
) -> _FakeConn:
    return _FakeConn(_FakeCursor(list(result_sets), raise_on_execute=raise_on_execute))


def _patch_pg(monkeypatch: pytest.MonkeyPatch, conn: _FakeConn) -> None:
    def _connect(_n: int, **_kw: object) -> _FakeConn:
        return conn

    monkeypatch.setattr(pg, "connect_to", _connect)


class _FakeApi:
    """Заглушка `WebappClient`: `batch_get` отдаёт `resp` либо бросает `error`."""

    def __init__(self, resp: dict[str, Any], *, error: Exception | None = None) -> None:
        self.resp = resp
        self.error = error
        self.calls: list[tuple[str, list[str], str]] = []

    def batch_get(
        self, ss_id: str, ranges: list[str], *, value_render: str = "UNFORMATTED_VALUE"
    ) -> dict[str, Any]:
        self.calls.append((ss_id, ranges, value_render))
        if self.error is not None:
            raise self.error
        return self.resp


def _patch_webapp(monkeypatch: pytest.MonkeyPatch, fake: _FakeApi) -> None:
    class _Stub:
        @classmethod
        def from_env(cls) -> _FakeApi:
            return fake

    monkeypatch.setattr(iu_wb, "WebappClient", _Stub)


# ── get-source-data ──────────────────────────────────────────────────────────


def test_get_source_data_print_ssh(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--print` без `--local` печатает ssh-обёртку с inner `service:iuWb getSourceData`."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    _patch_ssh_env(monkeypatch)
    result = runner.invoke(iu_wb.app, ["get-source-data", "2190", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.startswith("ssh -i ")
    assert "mp-sl-2-cli" in result.stdout
    assert 'sh -c "node cli service:iuWb getSourceData"' in result.stdout


def test_get_source_data_print_local(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--print --local` печатает локальную форму `sl-N-cli sh -c '...'` без ssh-lookup."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)
    result = runner.invoke(iu_wb.app, ["get-source-data", "2190", "--local", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == 'sl-2-cli sh -c "node cli service:iuWb getSourceData"'


def test_get_source_data_unresolvable_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нерезолвимый селектор → Exit(2) (через resolve_selector)."""

    def _raise(value: str, *, server_override: str | None = None) -> tuple[int, list[Any]]:
        _ = (value, server_override)
        raise ResolveError("nothing matched")

    monkeypatch.setattr(cli_wrap, "resolve_server", _raise)
    result = runner.invoke(iu_wb.app, ["get-source-data", "nope", "--print"])
    assert result.exit_code == 2
    assert "mpu iu-wb" in result.stderr


# ── make-sql ─────────────────────────────────────────────────────────────────


def test_make_sql_happy_explicit_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    """Полный SQL: схема клиента, proto-таблица, период и VALUES из входа."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190, spreadsheet_id="SS")])
    result = runner.invoke(
        iu_wb.app,
        [
            "make-sql",
            "2190",
            '[{"nm_id": 100, "perc": 30}]',
            "--date-from",
            "2025-01-01",
            "--date-to",
            "2025-06-25",
        ],
    )
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "WITH input(ord, nm_id, perc) AS (" in out
    assert "(1, 100::bigint, 30::numeric)" in out
    assert '"schema_2190".wb_cards' in out
    assert '"schema_2190".wb_unit_proto_new' in out
    assert 'INSERT INTO "schema_2190".wb_unit_manual_data' in out
    assert "generate_series('2025-01-01'::date, '2025-06-25'::date" in out


def test_make_sql_default_date_to_today(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без `--date-to` верхняя граница = сегодня (ISO)."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(iu_wb.app, ["make-sql", "2190", '[{"nm_id": 1, "perc": 5}]'])
    assert result.exit_code == 0, result.output
    today = datetime.date.today().isoformat()
    assert f"'{today}'::date" in result.stdout


def test_make_sql_custom_proto_table(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--proto-table` подставляется в SQL вместо дефолта."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(
        iu_wb.app,
        [
            "make-sql",
            "2190",
            '[{"nm_id": 1, "perc": 5}]',
            "--proto-table",
            "custom_proto",
            "--date-to",
            "2025-02-02",
        ],
    )
    assert result.exit_code == 0, result.output
    assert '"schema_2190".custom_proto' in result.stdout
    assert "wb_unit_proto_new" not in result.stdout


def test_make_sql_reads_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    """payload не задан → вход читается из stdin."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(
        iu_wb.app,
        ["make-sql", "2190", "--date-to", "2025-02-02"],
        input='[{"nm_id": 7, "perc": 12}]',
    )
    assert result.exit_code == 0, result.output
    assert "(1, 7::bigint, 12::numeric)" in result.stdout


def test_make_sql_multiple_rows_ordinals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Несколько строк → последовательные ord (1,2) и форматирование perc."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(
        iu_wb.app,
        [
            "make-sql",
            "2190",
            '[{"nm_id": 10, "perc": 15}, {"nm_id": 20, "perc": 25.5}]',
            "--date-to",
            "2025-02-02",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "(1, 10::bigint, 15::numeric)" in result.stdout
    assert "(2, 20::bigint, 25.5::numeric)" in result.stdout


def test_make_sql_empty_input_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет payload и пустой stdin → Exit(2) (read_iu_input до резолва)."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(iu_wb.app, ["make-sql", "2190"])
    assert result.exit_code == 2
    assert "пустой вход" in result.stderr


def test_make_sql_invalid_date_from_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Битый `--date-from` → Exit(2) с понятным сообщением."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(
        iu_wb.app,
        [
            "make-sql",
            "2190",
            '[{"nm_id": 1, "perc": 5}]',
            "--date-from",
            "2025-13-99",
            "--date-to",
            "2025-02-02",
        ],
    )
    assert result.exit_code == 2
    assert "--date-from" in result.stderr
    assert "YYYY-MM-DD" in result.stderr


def test_make_sql_invalid_date_to_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Битый `--date-to` → Exit(2)."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(
        iu_wb.app, ["make-sql", "2190", '[{"nm_id": 1, "perc": 5}]', "--date-to", "garbage"]
    )
    assert result.exit_code == 2
    assert "--date-to" in result.stderr


def test_make_sql_unresolvable_client_id_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Кандидаты без client_id → require Exit(2)."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand()])
    result = runner.invoke(iu_wb.app, ["make-sql", "2190", '[{"nm_id": 1, "perc": 5}]'])
    assert result.exit_code == 2
    assert "--client-id" in result.stderr


# ── _client_id ───────────────────────────────────────────────────────────────


def test_client_id_resolves_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """client_id + spreadsheet_id + server из единственного кандидата."""
    _patch_resolve(monkeypatch, server=3, candidates=[_cand(client_id=2190, spreadsheet_id="SS")])
    assert iu_wb._client_id("x") == (2190, "SS", 3)


def test_client_id_no_spreadsheet_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет spreadsheet_id среди кандидатов → ss = None (auto_pick_str)."""
    _patch_resolve(monkeypatch, server=3, candidates=[_cand(client_id=2190)])
    assert iu_wb._client_id("x") == (2190, None, 3)


def test_client_id_missing_client_id_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет client_id → require Exit(2)."""
    _patch_resolve(monkeypatch, server=3, candidates=[_cand()])
    with pytest.raises(typer.Exit) as exc:
        iu_wb._client_id("x")
    assert exc.value.exit_code == 2


# ── _check_date ──────────────────────────────────────────────────────────────


def test_check_date_valid_ok() -> None:
    """Корректная дата не бросает."""
    iu_wb._check_date("--date-from", "2025-01-01")


def test_check_date_invalid_exits(capsys: pytest.CaptureFixture[str]) -> None:
    """Некорректная дата → Exit(2), в сообщении — label и repr значения."""
    with pytest.raises(typer.Exit) as exc:
        iu_wb._check_date("--date-from", "not-a-date")
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "--date-from" in err
    assert "'not-a-date'" in err


# ── _resolve_subjects_and_targets ────────────────────────────────────────────


def test_resolve_subjects_happy(monkeypatch: pytest.MonkeyPatch) -> None:
    """subject_name на вход + полный список целевых nm_id; search_path выставлен, conn закрыт."""
    conn = _conn([(100, "Сумки"), (200, "Платья")], [(100,), (200,), (300,)])
    _patch_pg(monkeypatch, conn)
    subject_perc, targets = iu_wb._resolve_subjects_and_targets(
        2, 2190, "wb_unit_proto_new", [(100, 30.0), (200, 25.0)]
    )
    assert subject_perc == {"Сумки": 30.0, "Платья": 25.0}
    assert targets == [100, 200, 300]
    assert conn.closed is True
    # SET search_path + два SELECT'а
    assert len(conn.cur.executed) == 3


def test_resolve_subjects_first_perc_per_category(monkeypatch: pytest.MonkeyPatch) -> None:
    """Один subject у нескольких nm_id → perc первого по порядку (setdefault)."""
    conn = _conn([(100, "Сумки"), (200, "Сумки")], [(100,)])
    _patch_pg(monkeypatch, conn)
    subject_perc, targets = iu_wb._resolve_subjects_and_targets(
        2, 2190, "p", [(100, 30.0), (200, 40.0)]
    )
    assert subject_perc == {"Сумки": 30.0}
    assert targets == [100]


def test_resolve_subjects_empty_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пересечение с proto-таблицей пусто → target_nm_ids = []."""
    conn = _conn([(100, "Сумки")], [])
    _patch_pg(monkeypatch, conn)
    subject_perc, targets = iu_wb._resolve_subjects_and_targets(2, 2190, "p", [(100, 30.0)])
    assert subject_perc == {"Сумки": 30.0}
    assert targets == []


def test_resolve_subjects_none_subject_unresolved_exits(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """subject_name = NULL отбрасывается → nm попадает в unresolved → Exit(2)."""
    conn = _conn([(100, "Сумки"), (200, None)])
    _patch_pg(monkeypatch, conn)
    with pytest.raises(typer.Exit) as exc:
        iu_wb._resolve_subjects_and_targets(2, 2190, "p", [(100, 30.0), (200, 30.0)])
    assert exc.value.exit_code == 2
    err = capsys.readouterr().err
    assert "200" in err
    assert conn.closed is True  # finally закрывает соединение даже при Exit


def test_resolve_subjects_missing_nm_unresolved_exits(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """nm_id без строки в wb_cards → unresolved → Exit(2), nm в сообщении."""
    conn = _conn([(100, "Сумки")])
    _patch_pg(monkeypatch, conn)
    with pytest.raises(typer.Exit) as exc:
        iu_wb._resolve_subjects_and_targets(2, 2190, "p", [(100, 30.0), (999, 30.0)])
    assert exc.value.exit_code == 2
    assert "999" in capsys.readouterr().err


def test_resolve_subjects_db_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """psycopg.Error → Exit(1) c 'db error'; соединение закрывается в finally."""
    conn = _conn(raise_on_execute=psycopg.Error("boom"))
    _patch_pg(monkeypatch, conn)
    with pytest.raises(typer.Exit) as exc:
        iu_wb._resolve_subjects_and_targets(2, 2190, "p", [(100, 30.0)])
    assert exc.value.exit_code == 1
    assert "db error" in capsys.readouterr().err
    assert conn.closed is True


# ── _read_unit_formulas ──────────────────────────────────────────────────────


def test_read_unit_formulas_both_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """Обе ячейки с формулами → возвращаются как есть."""
    fake = _FakeApi({"valueRanges": [{"values": [["=A1"]]}, {"values": [["=B2"]]}]})
    _patch_webapp(monkeypatch, fake)
    assert iu_wb._read_unit_formulas("SS", "I6", "S4") == ("=A1", "=B2")


def test_read_unit_formulas_passes_formula_render(monkeypatch: pytest.MonkeyPatch) -> None:
    """batch_get вызывается с UNIT-диапазонами и value_render=FORMULA."""
    fake = _FakeApi({"valueRanges": []})
    _patch_webapp(monkeypatch, fake)
    iu_wb._read_unit_formulas("SHEET", "I7", "S9")
    assert fake.calls == [("SHEET", ["UNIT!I7", "UNIT!S9"], "FORMULA")]


def test_read_unit_formulas_no_value_ranges(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ответ без valueRanges → обе пустые строки."""
    fake = _FakeApi({})
    _patch_webapp(monkeypatch, fake)
    assert iu_wb._read_unit_formulas("SS", "I6", "S4") == ("", "")


def test_read_unit_formulas_only_one_range(monkeypatch: pytest.MonkeyPatch) -> None:
    """Один range в ответе → второй (idx вне диапазона) = пусто."""
    fake = _FakeApi({"valueRanges": [{"values": [["=A1"]]}]})
    _patch_webapp(monkeypatch, fake)
    assert iu_wb._read_unit_formulas("SS", "I6", "S4") == ("=A1", "")


def test_read_unit_formulas_none_cell(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ячейка = None → пустая строка (не 'None')."""
    fake = _FakeApi({"valueRanges": [{"values": [[None]]}, {"values": [["=B2"]]}]})
    _patch_webapp(monkeypatch, fake)
    assert iu_wb._read_unit_formulas("SS", "I6", "S4") == ("", "=B2")


def test_read_unit_formulas_empty_and_missing_values(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой values / отсутствие ключа values → пустые строки."""
    fake = _FakeApi({"valueRanges": [{"values": []}, {}]})
    _patch_webapp(monkeypatch, fake)
    assert iu_wb._read_unit_formulas("SS", "I6", "S4") == ("", "")


def test_read_unit_formulas_sheet_error_exits_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """SheetApiError из batch_get → Exit(1) с 'sheet'."""
    fake = _FakeApi({}, error=SheetApiError("boom"))
    _patch_webapp(monkeypatch, fake)
    with pytest.raises(typer.Exit) as exc:
        iu_wb._read_unit_formulas("SS", "I6", "S4")
    assert exc.value.exit_code == 1
    assert "sheet" in capsys.readouterr().err


# ── fix-formulas (интеграция всех seam'ов) ───────────────────────────────────


def test_fix_formulas_happy(monkeypatch: pytest.MonkeyPatch) -> None:
    """Полный путь: резолв → subjects/targets из БД → формулы из листа → JSON [{range, formula}]."""
    _patch_resolve(
        monkeypatch, server=2, candidates=[_cand(client_id=2190, spreadsheet_id="SS_ID")]
    )
    conn = _conn([(100, "Сумки")], [(100,), (200,)])
    _patch_pg(monkeypatch, conn)
    fake = _FakeApi(
        {"valueRanges": [{"values": [["iu_; {\n  }"]]}, {"values": [["iu_zero_nm_ids; {\n  }"]]}]}
    )
    _patch_webapp(monkeypatch, fake)
    result = runner.invoke(iu_wb.app, ["fix-formulas", "2190", '[{"nm_id": 100, "perc": 30}]'])
    assert result.exit_code == 0, result.output
    parsed = json.loads(result.stdout)
    assert len(parsed) == 2
    assert parsed[0]["range"] == "UNIT!I6:I"
    assert "Сумки" in parsed[0]["formula"]
    assert "30" in parsed[0]["formula"]
    assert parsed[1]["range"] == "UNIT!S4"
    assert "100" in parsed[1]["formula"] and "200" in parsed[1]["formula"]
    assert conn.closed is True
    assert fake.calls == [("SS_ID", ["UNIT!I6", "UNIT!S4"], "FORMULA")]


def test_fix_formulas_custom_i_from_and_s_cell(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--i-from` / `--s-cell` меняют адреса ячеек и range'ы вывода."""
    _patch_resolve(
        monkeypatch, server=2, candidates=[_cand(client_id=2190, spreadsheet_id="SS_ID")]
    )
    conn = _conn([(100, "Сумки")], [(100,)])
    _patch_pg(monkeypatch, conn)
    fake = _FakeApi(
        {"valueRanges": [{"values": [["iu_; {\n  }"]]}, {"values": [["iu_zero_nm_ids; {\n  }"]]}]}
    )
    _patch_webapp(monkeypatch, fake)
    result = runner.invoke(
        iu_wb.app,
        [
            "fix-formulas",
            "2190",
            '[{"nm_id": 100, "perc": 30}]',
            "--i-from",
            "10",
            "--s-cell",
            "S6",
        ],
    )
    assert result.exit_code == 0, result.output
    parsed = json.loads(result.stdout)
    assert parsed[0]["range"] == "UNIT!I10:I"
    assert parsed[1]["range"] == "UNIT!S6"
    assert fake.calls == [("SS_ID", ["UNIT!I10", "UNIT!S6"], "FORMULA")]


def test_fix_formulas_missing_spreadsheet_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Нет spreadsheet_id у клиента → require Exit(2) до обращения к БД/листу."""
    _patch_resolve(monkeypatch, server=2, candidates=[_cand(client_id=2190)])
    result = runner.invoke(iu_wb.app, ["fix-formulas", "2190", '[{"nm_id": 100, "perc": 30}]'])
    assert result.exit_code == 2
    assert "--spreadsheet-id" in result.stderr


def test_fix_formulas_unresolved_subject_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """nm_id без subject в БД → Exit(2) (внутри _resolve_subjects_and_targets)."""
    _patch_resolve(
        monkeypatch, server=2, candidates=[_cand(client_id=2190, spreadsheet_id="SS_ID")]
    )
    conn = _conn([])  # subject-запрос вернул пусто → 100 unresolved
    _patch_pg(monkeypatch, conn)
    result = runner.invoke(iu_wb.app, ["fix-formulas", "2190", '[{"nm_id": 100, "perc": 30}]'])
    assert result.exit_code == 2
    assert "subject" in result.stderr


def test_fix_formulas_empty_input_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустой вход → Exit(2) (read_iu_input первым)."""
    _patch_resolve(
        monkeypatch, server=2, candidates=[_cand(client_id=2190, spreadsheet_id="SS_ID")]
    )
    result = runner.invoke(iu_wb.app, ["fix-formulas", "2190"])
    assert result.exit_code == 2
    assert "пустой вход" in result.stderr
