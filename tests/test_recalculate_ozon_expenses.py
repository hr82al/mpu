"""Тесты `mpu ozon-recalculate-expenses` (`commands/recalculate_ozon_expenses.py`).

Покрывают:
- сборку ssh/local-обёртки через `--print` (фиксированный резолв + fake clipboard);
- трансформацию `--ref-fields` (singleton-collapse workaround) и `--skus` (bracket-литерал);
- дефолт `--date-to` = сегодня (мок `datetime.date.today`);
- live-автодополнение `--skus` (`_complete_sku`) с фейковым pg-курсором — happy path
  и все silent-`[]` ветки;
- остальные tab-complete helper'ы.

Резолв клиента/сервера, clipboard и pg мокаются — без сети/PG/ssh.
"""

import datetime
import types
from collections.abc import Iterator

import click
import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import recalculate_ozon_expenses as reoe
from mpu.lib import cli_wrap, clipboard, pg, resolver, servers

runner = CliRunner()

# Приватные символы — алиасы с одним подавлением (стиль test_wb_loader_blocked.py).
complete_ref_field = reoe._complete_ref_field  # pyright: ignore[reportPrivateUsage]
complete_logs_level = reoe._complete_logs_level  # pyright: ignore[reportPrivateUsage]
complete_today = reoe._complete_today  # pyright: ignore[reportPrivateUsage]
complete_date_from = reoe._complete_date_from  # pyright: ignore[reportPrivateUsage]
complete_sku = reoe._complete_sku  # pyright: ignore[reportPrivateUsage]
avoid_singleton_collapse = reoe._avoid_singleton_collapse  # pyright: ignore[reportPrivateUsage]
join_int_bracket = reoe._join_int_bracket  # pyright: ignore[reportPrivateUsage]
REF_FIELDS = reoe._REF_FIELDS  # pyright: ignore[reportPrivateUsage]
LOGS_LEVELS = reoe._LOGS_LEVELS  # pyright: ignore[reportPrivateUsage]

CANDIDATE: dict[str, object] = {
    "client_id": 2190,
    "spreadsheet_id": "1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c",
    "server": "sl-2",
    "title": "MODERNICA",
}

# Реальная дата, захваченная до любого патча datetime — для frozen-today.
_FROZEN = datetime.date(2026, 6, 25)


class _FrozenDate(datetime.date):
    @classmethod
    def today(cls) -> datetime.date:
        return _FROZEN


def _freeze_today(monkeypatch: pytest.MonkeyPatch) -> None:
    """Заморозить `datetime.date.today()` модуля на 2026-06-25 (изолированно от глобали)."""
    monkeypatch.setattr(reoe, "datetime", types.SimpleNamespace(date=_FrozenDate))


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Фейковый резолв client/server (sl-2, client_id 2190) + no-op clipboard."""

    def _fake_resolve(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 2, [CANDIDATE]

    monkeypatch.setattr(resolver, "resolve_server", _fake_resolve)
    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    monkeypatch.setattr(reoe, "resolve_server", _fake_resolve)

    def _sl_ip(_n: int) -> str | None:
        return "192.168.150.92"

    def _env_value(k: str) -> str | None:
        return "hr82al" if k == "PG_MY_USER_NAME" else None

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_copy)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)

    yield


SSH_PREFIX = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-2-cli sh -c"
)


# ── ssh / local форма ─────────────────────────────────────────────────────────


def test_ssh_basic(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        f"{SSH_PREFIX} "
        '"node cli service:ozonUnitCalculatedData recalculateExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        "--date-to 2025-01-31\"'"
    )


def test_local_basic(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--local", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ozonUnitCalculatedData recalculateExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        '--date-to 2025-01-31"'
    )


def test_no_optional_flags_omitted(fake_env: None) -> None:
    """Без доменных опций ref-date/ref-fields/skus/logs-level не печатаются."""
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    out = result.stdout
    assert "--ref-date" not in out
    assert "--ref-fields" not in out
    assert "--skus" not in out
    assert "--logs-level" not in out


# ── --date-to дефолт = сегодня ────────────────────────────────────────────────


def test_date_to_defaults_to_today(fake_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = fake_env
    _freeze_today(monkeypatch)
    result = runner.invoke(reoe.app, ["MODERNICA", "--date-from", "2025-01-01", "--print"])
    assert result.exit_code == 0, result.output
    assert "--date-from 2025-01-01" in result.stdout
    assert "--date-to 2026-06-25" in result.stdout


def test_date_from_default_2025_01_01(fake_env: None) -> None:
    """`--date-from` без значения = дефолт 2025-01-01."""
    _ = fake_env
    result = runner.invoke(reoe.app, ["MODERNICA", "--date-to", "2025-02-01", "--print"])
    assert result.exit_code == 0, result.output
    assert "--date-from 2025-01-01" in result.stdout


# ── --ref-fields: singleton-collapse workaround ───────────────────────────────


def test_ref_fields_single_duplicated(fake_env: None) -> None:
    """Одно значение дублируется (sl-back parseMethodArgs коллапсит скаляр)."""
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--date-to", "2025-02-01", "--ref-fields", "sebes_rub", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-fields sebes_rub sebes_rub" in result.stdout


def test_ref_fields_multiple_not_duplicated(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        [
            "MODERNICA",
            "--date-to",
            "2025-02-01",
            "--ref-fields",
            "sebes_rub",
            "--ref-fields",
            "tax",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-fields sebes_rub tax" in result.stdout


# ── --skus: bracket-литерал ───────────────────────────────────────────────────


def test_skus_single_bracket(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--date-to", "2025-02-01", "--skus", "5", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--skus [5]" in result.stdout


def test_skus_multiple_bracket(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        [
            "MODERNICA",
            "--date-to",
            "2025-02-01",
            "--skus",
            "1",
            "--skus",
            "2",
            "--skus",
            "3",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--skus [1,2,3]" in result.stdout


# ── ref-date / logs-level / client-id override / combined ──────────────────────


def test_ref_date_and_logs_level(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        [
            "MODERNICA",
            "--date-to",
            "2025-02-01",
            "--ref-date",
            "2025-03-01",
            "--logs-level",
            "debug",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-date 2025-03-01" in result.stdout
    assert "--logs-level debug" in result.stdout


def test_client_id_override(fake_env: None) -> None:
    """Явный `--client-id` перебивает auto_pick из резолва."""
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--client-id", "999", "--date-to", "2025-02-01", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--client-id 999" in result.stdout


def test_combined_all_flags_ordering(fake_env: None) -> None:
    """Полный набор флагов в порядке dict: client-id → date-from → date-to →
    ref-date → ref-fields → skus → logs-level."""
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        [
            "MODERNICA",
            "--local",
            "--date-from",
            "2025-01-01",
            "--date-to",
            "2025-01-31",
            "--ref-date",
            "2025-03-01",
            "--ref-fields",
            "sebes_rub",
            "--ref-fields",
            "tax",
            "--skus",
            "1",
            "--skus",
            "2",
            "--logs-level",
            "info",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:ozonUnitCalculatedData recalculateExpenses '
        "--client-id 2190 "
        "--date-from 2025-01-01 "
        "--date-to 2025-01-31 "
        "--ref-date 2025-03-01 "
        "--ref-fields sebes_rub tax "
        "--skus [1,2] "
        '--logs-level info"'
    )


def test_verbose_prints_inner_to_stderr(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        reoe.app,
        ["MODERNICA", "--date-to", "2025-02-01", "-v", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "# inner: node cli service:ozonUnitCalculatedData recalculateExpenses" in result.output
    assert "--client-id 2190" in result.output


def test_require_client_id_error(fake_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Резолв без int client_id → нечего auto_pick → Exit(2) с подсказкой."""
    _ = fake_env

    def _no_cid(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return 2, [{"server": "sl-2", "title": "X"}]

    monkeypatch.setattr(cli_wrap, "resolve_server", _no_cid)
    result = runner.invoke(reoe.app, ["X", "--print"])
    assert result.exit_code == 2, result.output
    assert "cannot resolve --client-id" in result.output


# ── pure helpers ──────────────────────────────────────────────────────────────


def test_avoid_singleton_collapse() -> None:
    assert avoid_singleton_collapse([]) == []
    assert avoid_singleton_collapse(["sebes_rub"]) == ["sebes_rub", "sebes_rub"]
    assert avoid_singleton_collapse(["a", "b"]) == ["a", "b"]


def test_join_int_bracket() -> None:
    assert join_int_bracket(None) is None
    assert join_int_bracket([]) is None
    assert join_int_bracket([5]) == "[5]"
    assert join_int_bracket([1, 2, 3]) == "[1,2,3]"


# ── tab-complete helpers ──────────────────────────────────────────────────────


def test_complete_ref_field() -> None:
    assert complete_ref_field("sebes") == ["sebes_rub"]
    assert complete_ref_field("") == list(REF_FIELDS)
    assert complete_ref_field("zzz") == []


def test_complete_logs_level() -> None:
    assert complete_logs_level("d") == ["debug"]
    assert complete_logs_level("") == list(LOGS_LEVELS)
    assert complete_logs_level("x") == []


def test_complete_date_from() -> None:
    assert complete_date_from("") == ["2025-01-01"]
    assert complete_date_from("2025") == ["2025-01-01"]
    assert complete_date_from("9") == []


def test_complete_today(monkeypatch: pytest.MonkeyPatch) -> None:
    _freeze_today(monkeypatch)
    assert complete_today("") == ["2026-06-25"]
    assert complete_today("2026") == ["2026-06-25"]
    assert complete_today("9") == []


# ── live SKU completion (_complete_sku) ───────────────────────────────────────


class _FakeCursor:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.rows = rows
        self.executed: tuple[str, tuple[object, ...]] | None = None

    def execute(self, sql: str, params: tuple[object, ...]) -> None:
        self.executed = (sql, params)

    def fetchall(self) -> list[tuple[object, ...]]:
        return self.rows

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _FakeConn:
    def __init__(self, cur: _FakeCursor) -> None:
        self._cur = cur

    def cursor(self) -> _FakeCursor:
        return self._cur

    def __enter__(self) -> "_FakeConn":
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _ctx(value: object) -> typer.Context:
    ctx = typer.Context(click.Command("main"))
    ctx.params = {"value": value}
    return ctx


def _patch_resolve(
    monkeypatch: pytest.MonkeyPatch, result: tuple[int, list[dict[str, object]]]
) -> None:
    def _fake(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        return result

    monkeypatch.setattr(reoe, "resolve_server", _fake)


def test_complete_sku_happy(monkeypatch: pytest.MonkeyPatch) -> None:
    cur = _FakeCursor([(101,), (202,)])

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    _patch_resolve(monkeypatch, (2, [CANDIDATE]))
    monkeypatch.setattr(pg, "connect_to", _fake_connect)

    out = complete_sku(_ctx("MODERNICA"), "")
    assert out == ["101", "202"]
    assert cur.executed is not None
    sql, params = cur.executed
    assert '"schema_2190".ozon_unit_proto' in sql
    assert params == ("%",)


def test_complete_sku_strips_non_digits(monkeypatch: pytest.MonkeyPatch) -> None:
    """incomplete с мусором → в LIKE уходит только цифровой префикс."""
    cur = _FakeCursor([(123,)])

    def _fake_connect(_n: int, **_kw: object) -> _FakeConn:
        return _FakeConn(cur)

    _patch_resolve(monkeypatch, (2, [CANDIDATE]))
    monkeypatch.setattr(pg, "connect_to", _fake_connect)

    out = complete_sku(_ctx("MODERNICA"), "12ab3")
    assert out == ["123"]
    assert cur.executed is not None
    assert cur.executed[1] == ("123%",)


def test_complete_sku_no_selector(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(_n: int, **_kw: object) -> _FakeConn:
        raise AssertionError("pg must not be touched without selector")

    monkeypatch.setattr(pg, "connect_to", _boom)
    assert complete_sku(_ctx(None), "") == []


def test_complete_sku_empty_selector(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(_n: int, **_kw: object) -> _FakeConn:
        raise AssertionError("pg must not be touched")

    monkeypatch.setattr(pg, "connect_to", _boom)
    assert complete_sku(_ctx(""), "") == []


def test_complete_sku_non_str_selector(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(_n: int, **_kw: object) -> _FakeConn:
        raise AssertionError("pg must not be touched")

    monkeypatch.setattr(pg, "connect_to", _boom)
    assert complete_sku(_ctx(123), "") == []


def test_complete_sku_resolve_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(
        _value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        raise RuntimeError("resolve boom")

    monkeypatch.setattr(reoe, "resolve_server", _raise)
    assert complete_sku(_ctx("MODERNICA"), "") == []


def test_complete_sku_zero_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    """Кандидаты без int client_id → нечего резолвить → []."""
    _patch_resolve(monkeypatch, (2, [{"server": "sl-2"}]))
    assert complete_sku(_ctx("MODERNICA"), "") == []


def test_complete_sku_multiple_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_resolve(monkeypatch, (2, [{"client_id": 1}, {"client_id": 2}]))
    assert complete_sku(_ctx("MODERNICA"), "") == []


def test_complete_sku_connect_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(_n: int, **_kw: object) -> _FakeConn:
        raise RuntimeError("pg down")

    _patch_resolve(monkeypatch, (2, [CANDIDATE]))
    monkeypatch.setattr(pg, "connect_to", _boom)
    assert complete_sku(_ctx("MODERNICA"), "") == []
