"""Тесты `mpu ozon-fix-fo-tax` (mpu.commands.ozon_fix_fo_tax).

Покрывают:
- генерацию SQL (`_ranked_cte`/`_fix_sql`/`_preview_sql`) — подстановка схемы, поля;
- генерацию run-js скрипта `_build_js` — dry/non-dry, client_id в схеме, валидность
  JSON-payload'ов;
- оркестрацию `main` под CliRunner с замоканными швами (`resolve_selector`,
  `pssh.pssh_run`, `emit_node_cli`, `datetime.date.today`) — порядок и флаги шагов,
  дефолт даты-по-сегодня, dry-run, и error-пути (нерезолвленный селектор, fail step 1,
  невыводимые client_id / spreadsheet_id).
"""
# pyright: reportPrivateUsage=false

import datetime
import json
import re
from typing import TypedDict

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import ozon_fix_fo_tax as cmd
from mpu.lib import pssh
from mpu.lib.cli_wrap import FlagValue, Resolved

runner = CliRunner()


# ── pure SQL builders ─────────────────────────────────────────────────────────


def test_ranked_cte_schema_and_window() -> None:
    """CTE подставляет схему в FROM и описывает окно forward-fill по sku."""
    cte = cmd._ranked_cte("schema_42")
    assert "FROM schema_42.ozon_postings_reports" in cte
    assert "public.find_last_ignore_nulls(" in cte
    assert "PARTITION BY sku ORDER BY accepted_for_processing ASC" in cte
    assert "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING" in cte
    # все 4 поля forward-fill'ятся одним условием product_cost_for_customers <> 1
    for col in ("pv_total", "pv_cost", "pv_pcur", "pv_ccur"):
        assert f"AS {col}" in cte
    assert cte.count("product_cost_for_customers <> 1") == 4


def test_fix_sql_update_targets() -> None:
    """UPDATE бьёт только по аномальным (=1) строкам с найденной предыдущей ценой."""
    sql = cmd._fix_sql("schema_42")
    assert sql.startswith("WITH ranked AS (")
    assert "UPDATE schema_42.ozon_postings_reports AS o" in sql
    for col in (
        "total_product_cost",
        "product_cost_for_customers",
        "product_currency_code",
        "customer_currency_code",
    ):
        assert col in sql
    assert "WHERE o.posting_number = r.posting_number AND o.sku = r.sku" in sql
    assert "o.product_cost_for_customers = 1" in sql
    assert "r.pv_cost IS NOT NULL" in sql


def test_preview_sql_counts() -> None:
    """Превью считает три бакета аномалий, ничего не пишет."""
    sql = cmd._preview_sql("schema_42")
    assert "FROM ranked" in sql
    assert "UPDATE" not in sql
    for alias in ("anomalies", "fixable", "no_prev_valid"):
        assert f"AS {alias}" in sql
    assert "FILTER (WHERE product_cost_for_customers = 1)" in sql


# ── _build_js (run-js скрипт) ─────────────────────────────────────────────────


def test_build_js_dry_true_flag() -> None:
    js = cmd._build_js(client_id=2190, dry_run=True)
    assert "const DRY = true;" in js
    assert 'import { db } from "#db/db.js";' in js
    # схема пробрасывается в обе встроенные SQL-строки
    assert "schema_2190.ozon_postings_reports" in js


def test_build_js_dry_false_flag() -> None:
    js = cmd._build_js(client_id=2190, dry_run=False)
    assert "const DRY = false;" in js


def test_build_js_no_placeholders_left() -> None:
    """Все плейсхолдеры заменены — иначе node упадёт синтаксис-ошибкой."""
    js = cmd._build_js(client_id=777, dry_run=True)
    assert "__DRY__" not in js
    assert "__FIX__" not in js
    assert "__PREVIEW__" not in js


def test_build_js_client_id_in_schema() -> None:
    js = cmd._build_js(client_id=777, dry_run=False)
    assert "schema_777.ozon_postings_reports" in js
    assert "schema_2190" not in js


def test_build_js_payloads_are_valid_json() -> None:
    """FIX_SQL / PREVIEW_SQL встроены как валидный JSON — переносы строк экранированы,
    обратная десериализация даёт исходный SQL."""
    js = cmd._build_js(client_id=5, dry_run=True)

    fix_match = re.search(r"^const FIX_SQL = (.+);$", js, re.MULTILINE)
    prev_match = re.search(r"^const PREVIEW_SQL = (.+);$", js, re.MULTILINE)
    assert fix_match is not None
    assert prev_match is not None

    fix_decoded = json.loads(fix_match.group(1))
    prev_decoded = json.loads(prev_match.group(1))
    assert fix_decoded == cmd._fix_sql("schema_5")
    assert prev_decoded == cmd._preview_sql("schema_5")


# ── оркестрация main под CliRunner ────────────────────────────────────────────

_SS = "1Mrx_IHT2ovSS"

FAKE_RESOLVED = Resolved(
    server_number=2,
    sl_ip=None,
    user=None,
    candidates=[{"client_id": 2190, "spreadsheet_id": _SS, "server": "sl-2", "title": "MODERNICA"}],
    selector="MODERNICA",
)


class _Step(TypedDict):
    name: str
    method: str
    flags: dict[str, FlagValue]
    wrapper: str


class _PsshCall(TypedDict):
    server_number: int
    cmd: list[str]
    stdin: str


class _Capture(TypedDict):
    pssh: list[_PsshCall]
    steps: list[_Step]
    rc: int


class _FakeDate:
    @staticmethod
    def today() -> datetime.date:
        return datetime.date(2026, 6, 25)


class _FakeDatetime:
    date = _FakeDate


@pytest.fixture
def orch(monkeypatch: pytest.MonkeyPatch) -> _Capture:
    """Замокать все внешние швы main: резолв, run-js шаг, node-шаги, дату-сегодня."""
    cap: _Capture = {"pssh": [], "steps": [], "rc": 0}

    def _fake_resolve(**_: object) -> Resolved:
        return FAKE_RESOLVED

    def _fake_pssh_run(*, server_number: int, cmd: list[str], stdin: bytes = b"") -> int:
        cap["pssh"].append(
            {"server_number": server_number, "cmd": cmd, "stdin": stdin.decode("utf-8")}
        )
        return cap["rc"]

    def _fake_emit(
        *,
        name: str,
        method: str,
        flags: dict[str, FlagValue],
        resolved: Resolved,
        wrapper: str = "portainer",
        command_name: str,
    ) -> str:
        cap["steps"].append(
            {"name": name, "method": method, "flags": dict(flags), "wrapper": wrapper}
        )
        return ""

    monkeypatch.setattr(cmd, "resolve_selector", _fake_resolve)
    monkeypatch.setattr(pssh, "pssh_run", _fake_pssh_run)
    monkeypatch.setattr(cmd, "emit_node_cli", _fake_emit)
    monkeypatch.setattr(cmd, "datetime", _FakeDatetime)
    return cap


def test_full_chain_emits_step1_then_four_node_steps(orch: _Capture) -> None:
    """Happy path: один run-js (step 1) + 4 node-шага в фиксированном порядке."""
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output

    assert len(orch["pssh"]) == 1
    call = orch["pssh"][0]
    assert call["server_number"] == 2
    assert call["cmd"] == ["node", "--input-type=module", "-"]
    assert "const DRY = false;" in call["stdin"]
    assert "schema_2190.ozon_postings_reports" in call["stdin"]

    order = [(s["name"], s["method"]) for s in orch["steps"]]
    assert order == [
        ("ozonUnitCalculatedData", "recalculateExpenses"),
        ("ozonUnitCalculatedData", "saveExpenses"),
        ("dataProcessor", "process"),
        ("ssUpdater", "update"),
    ]
    assert all(s["wrapper"] == "portainer" for s in orch["steps"])


def test_date_to_defaults_to_today(orch: _Capture) -> None:
    """Без --date-to конечная дата = monkeypatched date.today()."""
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    assert "range=2025-01-01..2026-06-25" in res.output

    recalc = orch["steps"][0]
    assert recalc["flags"]["--date-from"] == "2025-01-01"
    assert recalc["flags"]["--date-to"] == "2026-06-25"


def test_date_range_explicit_overrides_today(orch: _Capture) -> None:
    res = runner.invoke(
        cmd.app,
        ["MODERNICA", "--date-from", "2024-03-01", "--date-to", "2024-12-31"],
    )
    assert res.exit_code == 0, res.output
    assert "range=2024-03-01..2024-12-31" in res.output

    recalc = orch["steps"][0]
    assert recalc["flags"]["--date-from"] == "2024-03-01"
    assert recalc["flags"]["--date-to"] == "2024-12-31"


def test_recalc_and_save_share_identical_flags(orch: _Capture) -> None:
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    expected: dict[str, FlagValue] = {
        "--client-id": 2190,
        "--date-from": "2025-01-01",
        "--date-to": "2026-06-25",
    }
    assert orch["steps"][0]["flags"] == expected
    assert orch["steps"][1]["flags"] == expected


def test_process_step_flags(orch: _Capture) -> None:
    """Шаг 4 — forced пересчёт ozon-домена со spreadsheet_id и датами."""
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    process = orch["steps"][2]
    assert process["flags"] == {
        "--client-id": 2190,
        "--spreadsheet-id": _SS,
        "--forced": True,
        "--domain": "ozon",
        "--date-from": "2025-01-01",
        "--date-to": "2026-06-25",
    }


def test_ss_update_step_flags_have_no_dates(orch: _Capture) -> None:
    """Шаг 5 — ss-update без диапазона дат (расписание)."""
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    ss = orch["steps"][3]
    assert ss["flags"] == {
        "--client-id": 2190,
        "--spreadsheet-id": _SS,
        "--update-type": "schedule",
        "--logs": "info",
    }


def test_header_echo_has_context(orch: _Capture) -> None:
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    assert "sl-2 client_id=2190 ss=" in res.output
    assert "dry_run=False" in res.output


def test_explicit_client_and_spreadsheet_override(orch: _Capture) -> None:
    """--client-id / --spreadsheet-id перебивают auto-pick из кандидатов."""
    res = runner.invoke(
        cmd.app,
        ["MODERNICA", "--client-id", "999", "--spreadsheet-id", "SS999"],
    )
    assert res.exit_code == 0, res.output
    # client_id уходит в схему run-js скрипта
    assert "schema_999.ozon_postings_reports" in orch["pssh"][0]["stdin"]
    process = orch["steps"][2]
    assert process["flags"]["--client-id"] == 999
    assert process["flags"]["--spreadsheet-id"] == "SS999"


def test_auto_pick_seams_are_used(orch: _Capture, monkeypatch: pytest.MonkeyPatch) -> None:
    """Когда флаги не заданы — client_id/spreadsheet_id берутся из auto_pick_*."""

    def _pick_int(_candidates: list[dict[str, object]], _field: str) -> int | None:
        return 4242

    def _pick_str(_candidates: list[dict[str, object]], _field: str) -> str | None:
        return "SSAUTO"

    monkeypatch.setattr(cmd, "auto_pick_int", _pick_int)
    monkeypatch.setattr(cmd, "auto_pick_str", _pick_str)

    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 0, res.output
    assert "schema_4242.ozon_postings_reports" in orch["pssh"][0]["stdin"]
    assert orch["steps"][2]["flags"]["--client-id"] == 4242
    assert orch["steps"][2]["flags"]["--spreadsheet-id"] == "SSAUTO"


# ── dry-run ───────────────────────────────────────────────────────────────────


def test_dry_run_previews_and_skips_node_steps(orch: _Capture) -> None:
    """--dry-run: run-js идёт read-only превью, node-шаги только печатаются."""
    res = runner.invoke(cmd.app, ["MODERNICA", "--dry-run"])
    assert res.exit_code == 0, res.output

    # step 1 всё равно вызывается, но в режиме превью (DRY=true)
    assert len(orch["pssh"]) == 1
    assert "const DRY = true;" in orch["pssh"][0]["stdin"]

    # node-шаги (2–5) НЕ выполняются — emit_node_cli не вызван
    assert orch["steps"] == []

    assert "dry_run=True" in res.output
    for fragment in (
        "#   would run: node cli service:ozonUnitCalculatedData recalculateExpenses",
        "#   would run: node cli service:ozonUnitCalculatedData saveExpenses",
        "#   would run: node cli service:dataProcessor process",
        "#   would run: node cli service:ssUpdater update",
    ):
        assert fragment in res.output


def test_dry_run_process_inner_has_forced_and_domain(orch: _Capture) -> None:
    res = runner.invoke(cmd.app, ["MODERNICA", "--dry-run"])
    assert res.exit_code == 0, res.output
    assert "--forced --domain ozon" in res.output
    assert "--date-from 2025-01-01 --date-to 2026-06-25" in res.output


# ── error-пути ────────────────────────────────────────────────────────────────


def test_selector_unresolved_propagates_exit(
    orch: _Capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """resolve_selector кинул typer.Exit(2) → команда падает, ничего не выполняя."""

    def _raise(**_: object) -> Resolved:
        raise typer.Exit(code=2)

    monkeypatch.setattr(cmd, "resolve_selector", _raise)
    res = runner.invoke(cmd.app, ["nonsense"])
    assert res.exit_code == 2
    assert orch["pssh"] == []
    assert orch["steps"] == []


def test_step1_failure_aborts_chain(orch: _Capture) -> None:
    """Ненулевой rc на step 1 → fail-fast, node-шаги не запускаются."""
    orch["rc"] = 1
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 1
    assert "price-fix step failed (rc=1)" in res.output
    assert len(orch["pssh"]) == 1
    assert orch["steps"] == []


def test_step1_failure_propagates_exact_rc(orch: _Capture) -> None:
    orch["rc"] = 3
    res = runner.invoke(cmd.app, ["MODERNICA"])
    assert res.exit_code == 3
    assert orch["steps"] == []


def test_unresolvable_client_id_exits_2(orch: _Capture, monkeypatch: pytest.MonkeyPatch) -> None:
    """Пустые кандидаты + нет --client-id → require падает до step 1."""
    empty = Resolved(server_number=2, sl_ip=None, user=None, candidates=[], selector="x")

    def _fake_resolve(**_: object) -> Resolved:
        return empty

    monkeypatch.setattr(cmd, "resolve_selector", _fake_resolve)
    res = runner.invoke(cmd.app, ["x"])
    assert res.exit_code == 2
    assert "cannot resolve --client-id" in res.output
    assert orch["pssh"] == []


def test_unresolvable_spreadsheet_id_exits_2(
    orch: _Capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """client_id выводится, а spreadsheet_id — нет → require падает на нём, до step 1."""
    only_cid = Resolved(
        server_number=2,
        sl_ip=None,
        user=None,
        candidates=[{"client_id": 2190}],
        selector="x",
    )

    def _fake_resolve(**_: object) -> Resolved:
        return only_cid

    monkeypatch.setattr(cmd, "resolve_selector", _fake_resolve)
    res = runner.invoke(cmd.app, ["x"])
    assert res.exit_code == 2
    assert "cannot resolve --spreadsheet-id" in res.output
    assert orch["pssh"] == []
