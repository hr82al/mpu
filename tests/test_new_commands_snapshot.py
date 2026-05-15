"""Snapshot-тесты на все новые entry-point'ы (Phase 2-4 миграции).

Каждый subcommand → один ssh-snapshot. Стратегия проверки — полное байт-в-байт
соответствие stdout от CliRunner ожидаемой строке.

Селектор `MODERNICA` в фейковом резолве маппится на `client_id=2190, server=sl-2,
spreadsheet_id=1Mrx_...`. SSH-обёртка предсказуема: `ssh -i ~/.ssh/id_rsa -t hr82al@192.168.150.92`.
"""

from collections.abc import Iterator

import pytest
from typer.testing import CliRunner

from mpu.commands import (
    app_migrations,
    clients_migrations,
    data_loader,
    data_loader_jobs,
    datasets_migrations,
    iu_wb,
    ozon_jobs,
    ozon_loader,
    recalculate_ozon_expenses,
    save_ozon_expenses,
    ss_datasets,
    ss_load,
    users,
    wb_jobs,
    wb_loader,
    wb_unit_calc,
    wb_unit_proto_new,
)
from mpu.lib import cli_wrap, clipboard, resolver, servers

runner = CliRunner()

CANDIDATE: dict[str, object] = {
    "client_id": 2190,
    "spreadsheet_id": "1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c",
    "server": "sl-2",
    "title": "MODERNICA",
}

SSH_PREFIX = (
    "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-2-cli sh -c"
)


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def _fake_resolve(
        value: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        if server_override:
            n = servers.server_number(server_override)
            assert n is not None, f"bad --server in test: {server_override!r}"
            return n, []
        # Short-circuit sl-N (mirrors real resolver.resolve_server).
        sn = servers.server_number(value)
        if sn is not None:
            return sn, []
        return 2, [CANDIDATE]

    def _sl_ip(_n: int) -> str | None:
        return "192.168.150.92"

    def _env_value(k: str) -> str | None:
        return "hr82al" if k == "PG_MY_USER_NAME" else None

    def _noop_copy(_t: str) -> bool:
        return True

    monkeypatch.setattr(resolver, "resolve_server", _fake_resolve)
    monkeypatch.setattr(cli_wrap, "resolve_server", _fake_resolve)
    monkeypatch.setattr(servers, "sl_ip", _sl_ip)
    monkeypatch.setattr(servers, "env_value", _env_value)
    monkeypatch.setattr(clipboard, "copy_to_clipboard", _noop_copy)
    monkeypatch.setattr(cli_wrap, "copy_to_clipboard", _noop_copy)
    yield


def _ssh(inner: str) -> str:
    return f'{SSH_PREFIX} "{inner}"\''


# ── wb_loader ────────────────────────────────────────────────────────────────
WB_LOADER_CASES: list[tuple[list[str], str]] = [
    (["reports", "MODERNICA", "--sid", "abcd", "--print"], "wbReports"),
    (["cards", "MODERNICA", "--sid", "abcd", "--print"], "wbCards"),
    (["adv-auto-keywords-stats", "MODERNICA", "--sid", "abcd", "--print"], "wbAdvAutoKeywordsStats"),
    (["adv-fullstats", "MODERNICA", "--sid", "abcd", "--print"], "wbAdvFullstats"),
    (["search-texts", "MODERNICA", "--sid", "abcd", "--print"], "wbSearchTexts"),
    (["analytics-by-period", "MODERNICA", "--sid", "abcd", "--print"], "wbAnalyticsByPeriod"),
    (["adverts", "MODERNICA", "--sid", "abcd", "--print"], "wbAdverts"),
    (["search-clusters-bids", "MODERNICA", "--sid", "abcd", "--print"], "wbSearchClustersBids"),
]


@pytest.mark.parametrize(("args", "method"), WB_LOADER_CASES)
def test_wb_loader_ssh(fake_env: None, args: list[str], method: str) -> None:
    _ = fake_env
    result = runner.invoke(wb_loader.app, args)
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        f"node cli service:wbLoader {method} --client-id 2190 --sid abcd"
    )


# ── wb_jobs ──────────────────────────────────────────────────────────────────
def test_wb_jobs_show_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(wb_jobs.app, ["--print", "sl-2", "show"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh("node cli service:wbJobs showJobs")


# ── wb_unit_calc ─────────────────────────────────────────────────────────────
def test_wb_unit_calc_get_unit_data_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        wb_unit_calc.app,
        ["get-unit-data-by-date-nm-id", "MODERNICA", "--nm-id", "139", "--date", "2026-04-01", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:wbUnitCalc getUnitDataByDateNmId "
        "--client-id 2190 --nm-id 139 --date 2026-04-01"
    )


# ── wb_unit_proto_new ────────────────────────────────────────────────────────
def test_wb_unit_proto_new_copy_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(wb_unit_proto_new.app, ["copy-data-from-old-table", "MODERNICA", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:wbUnitProtoNew copyDataFromOldTable --client-id 2190"
    )


# ── iu_wb ────────────────────────────────────────────────────────────────────
def test_iu_wb_get_source_data_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(iu_wb.app, ["--print", "sl-2", "get-source-data"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh("node cli service:iuWb getSourceData")


# ── ozon_loader ──────────────────────────────────────────────────────────────
OZON_LOADER_CASES: list[tuple[list[str], str]] = [
    (["postings-reports", "MODERNICA", "--seller-client-id", "777", "--print"], "ozonPostingsReports"),
    (["performance-reports", "MODERNICA", "--seller-client-id", "777", "--print"], "ozonPerformanceReports"),
    (["search-promo", "MODERNICA", "--seller-client-id", "777", "--print"], "ozonSearchPromo"),
    (
        ["campaign-daily-statistics", "MODERNICA", "--seller-client-id", "777", "--print"],
        "ozonCampaignDailyStatistics",
    ),
    (["campaigns", "MODERNICA", "--seller-client-id", "777", "--print"], "ozonCampaigns"),
    (["transactions", "MODERNICA", "--seller-client-id", "777", "--print"], "ozonTransactions"),
]


@pytest.mark.parametrize(("args", "method"), OZON_LOADER_CASES)
def test_ozon_loader_ssh(fake_env: None, args: list[str], method: str) -> None:
    _ = fake_env
    result = runner.invoke(ozon_loader.app, args)
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        f"node cli service:ozonLoader {method} --client-id 2190 --seller-client-id 777"
    )


def test_ozon_loader_load_data_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ozon_loader.app,
        ["load-data", "MODERNICA", "--seller-client-id", "777", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "service:ozonLoader loadData --client-id 2190 --seller-client-ids 777 --sequence" in (
        result.stdout
    )
    assert "ozonProductInfo" in result.stdout
    assert "ozonPostingsReports" in result.stdout


# ── ozon_jobs ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("sub", "method"),
    [("show", "showJobs"), ("prune", "pruneJobs")],
)
def test_ozon_jobs_ssh(fake_env: None, sub: str, method: str) -> None:
    _ = fake_env
    result = runner.invoke(ozon_jobs.app, ["--print", "sl-2", sub])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(f"node cli service:ozonJobs {method}")


# ── ozon expenses ────────────────────────────────────────────────────────────
def test_ozon_recalculate_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ozonUnitCalculatedData recalculateExpenses "
        "--client-id 2190 --date-from 2025-01-01 --date-to 2025-01-31"
    )


def test_ozon_recalculate_with_ref_date_and_logs_level(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        [
            "MODERNICA",
            "--date-from", "2025-01-01",
            "--date-to", "2025-01-31",
            "--ref-date", "2025-06-17",
            "--logs-level", "debug",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-date 2025-06-17" in result.stdout
    assert "--logs-level debug" in result.stdout


def test_ozon_recalculate_ref_fields_multiple(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        [
            "MODERNICA",
            "--date-from", "2025-01-01",
            "--ref-fields", "sebes_rub",
            "--ref-fields", "markirovka_rub",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-fields sebes_rub markirovka_rub" in result.stdout


def test_ozon_recalculate_ref_fields_single_value_duplicated(fake_env: None) -> None:
    """Single-value workaround: sl-back parseMethodArgs коллапсит --flag X в скаляр,
    а changeRefData ждёт массив. mpu дублирует значение при len==1."""
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--ref-fields", "sebes_rub", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--ref-fields sebes_rub sebes_rub" in result.stdout


def test_ozon_recalculate_skus_multiple(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01",
         "--skus", "1", "--skus", "2", "--skus", "4", "--print"],
    )
    assert result.exit_code == 0, result.output
    # Эмитим JSON-литерал — sl-back-парсер распознаёт через tryToParseJson
    assert "--skus [1,2,4]" in result.stdout


def test_ozon_recalculate_skus_single(fake_env: None) -> None:
    """Single sku — JSON-литерал работает даже для одного элемента,
    в отличие от --ref-fields (там single-value collapse-bug)."""
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--skus", "5", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert "--skus [5]" in result.stdout


def test_ozon_recalculate_verbose_prints_inner_to_stderr(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        recalculate_ozon_expenses.app,
        [
            "MODERNICA",
            "--date-from", "2025-01-01",
            "--date-to", "2025-01-31",
            "--ref-date", "2025-06-17",
            "--skus", "5",
            "-v",
            "--print",
        ],
    )
    assert result.exit_code == 0, result.output
    # `-v` печатает в stderr строку с inner-командой; CliRunner объединяет stderr с stdout
    # через result.output (mix_stderr по умолчанию True).
    assert "# inner: node cli service:ozonUnitCalculatedData recalculateExpenses" in result.output
    assert "--ref-date 2025-06-17" in result.output
    assert "--skus [5]" in result.output


def test_ozon_save_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        save_ozon_expenses.app,
        ["MODERNICA", "--date-from", "2025-01-01", "--date-to", "2025-01-31", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ozonUnitCalculatedData saveExpenses "
        "--client-id 2190 --date-from 2025-01-01 --date-to 2025-01-31"
    )


# ── clients_migrations ───────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("sub", "extra_args", "extra_inner"),
    [
        ("latest", [], ""),
        ("up", [], ""),
        ("rollback", [], ""),
        ("down", [], ""),
        ("init", [], ""),
    ],
)
def test_clients_migrations_ssh(
    fake_env: None, sub: str, extra_args: list[str], extra_inner: str
) -> None:
    _ = fake_env
    result = runner.invoke(
        clients_migrations.app, [sub, "MODERNICA", "--type", "wb", *extra_args, "--print"]
    )
    assert result.exit_code == 0, result.output
    expected = f"node cli service:clientsMigrations {sub} --client-id 2190 --type wb{extra_inner}"
    assert result.stdout.strip() == _ssh(expected)


def test_clients_migrations_up_with_name_forced(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        clients_migrations.app,
        ["up", "MODERNICA", "--type", "wb", "--name", "20260101_test", "--forced", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:clientsMigrations up "
        "--client-id 2190 --type wb --name 20260101_test --forced"
    )


def test_clients_migrations_latest_all_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(clients_migrations.app, ["latest-all", "sl-2", "--type", "wb", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh("node cli service:clientsMigrations latestAll --type wb")


# ── datasets_migrations ──────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "sub",
    ["latest", "up", "rollback", "down", "list"],
)
def test_datasets_migrations_ssh(fake_env: None, sub: str) -> None:
    _ = fake_env
    result = runner.invoke(
        datasets_migrations.app,
        [sub, "MODERNICA", "--dataset", "wb10xSalesFinReport_v1", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        f"node cli service:datasetsMigrations {sub} "
        "--client-id 2190 --dataset wb10xSalesFinReport_v1"
    )


# ── app_migrations ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("sub", ["latest", "up"])
def test_app_migrations_ssh(fake_env: None, sub: str) -> None:
    _ = fake_env
    result = runner.invoke(app_migrations.app, ["--print", "sl-2", sub])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(f"node cli service:appMigrations {sub}")


# ── ss_load ──────────────────────────────────────────────────────────────────
def test_ss_load_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(ss_load.app, ["MODERNICA", "--dataset", "wb10x_promotions_v3", "--print"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssLoader load --dataset wb10x_promotions_v3 "
        "--client-id 2190 "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--logs info"
    )


# ── ss_datasets ──────────────────────────────────────────────────────────────
def test_ss_datasets_add_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        ss_datasets.app, ["add", "MODERNICA", "--dataset", "ozon10xUnit_v1", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:ssDatasets add "
        "--spreadsheet-id 1Mrx_IHT2ov-aWGcE8pt1Ml60VZe3oDyN2_kudxZ_u7c "
        "--dataset ozon10xUnit_v1"
    )


# ── users ────────────────────────────────────────────────────────────────────
def test_users_add_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        users.app,
        ["--print", "sl-1", "add", "--email", "test@example.com", "--id", "10"],
    )
    assert result.exit_code == 0, result.output
    inner = "node cli service:users add --email test@example.com --id 10"
    expected_prefix = (
        "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-1-cli sh -c"
    )
    assert result.stdout.strip() == f'{expected_prefix} "{inner}"\''


def test_users_add_role_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        users.app,
        ["--print", "sl-1", "add-role", "--id", "70", "--role", "client"],
    )
    assert result.exit_code == 0, result.output
    expected_prefix = (
        "ssh -i /home/user/.ssh/id_rsa -t hr82al@192.168.150.92 'docker exec -it mp-sl-1-cli sh -c"
    )
    assert result.stdout.strip() == (
        f'{expected_prefix} "node cli service:users addRole --id 70 --role client"\''
    )


# ── data_loader ──────────────────────────────────────────────────────────────
def test_data_loader_find_candidate_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        data_loader.app,
        ["find-candidate", "MODERNICA", "--sids", "41a47777-e1e3-41ca-9708-d9656be3deb7", "--print"],
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh(
        "node cli service:dataLoader findCandidate "
        "--client-id 2190 --sids 41a47777-e1e3-41ca-9708-d9656be3deb7"
    )


# ── data_loader_jobs ─────────────────────────────────────────────────────────
def test_data_loader_jobs_show_ssh(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(data_loader_jobs.app, ["--print", "sl-2", "show"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == _ssh("node cli service:dataLoaderJobs showJobs")


# ── --local sanity (по одному на category) ───────────────────────────────────
def test_wb_loader_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(wb_loader.app, ["reports", "MODERNICA", "--sid", "abcd", "--print", "--local"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:wbLoader wbReports --client-id 2190 --sid abcd"'
    )


def test_wb_jobs_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(wb_jobs.app, ["--local", "--print", "sl-2", "show"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == 'sl-2-cli sh -c "node cli service:wbJobs showJobs"'


def test_clients_migrations_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(
        clients_migrations.app, ["latest", "MODERNICA", "--type", "wb", "--local", "--print"]
    )
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == (
        'sl-2-cli sh -c "node cli service:clientsMigrations latest --client-id 2190 --type wb"'
    )


def test_app_migrations_local(fake_env: None) -> None:
    _ = fake_env
    result = runner.invoke(app_migrations.app, ["--local", "--print", "sl-2", "latest"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == 'sl-2-cli sh -c "node cli service:appMigrations latest"'


def test_typer_ambiguity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Что показывает CLI если selector неоднозначен (≥2 кандидата на разные сервера)."""
    from mpu.lib.resolver import ResolveError

    def _raise(
        _v: str, *, server_override: str | None = None
    ) -> tuple[int, list[dict[str, object]]]:
        _ = server_override
        raise ResolveError(
            "ambiguous selector",
            candidates=[{"client_id": 1, "server": "sl-1"}, {"client_id": 2, "server": "sl-2"}],
        )

    monkeypatch.setattr(cli_wrap, "resolve_server", _raise)
    result = runner.invoke(wb_loader.app, ["reports", "VAGUE", "--sid", "abcd"])
    assert result.exit_code == 2
    assert "ambiguous" in result.output
