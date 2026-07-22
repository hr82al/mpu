"""Тесты `mpu glab-status` — чистые функции + CLI через фейк-клиент (без сети).

Сам HTTP-клиент (GitLabClient) тестами не покрыт — прецедент mr/kaiten; вместо него
дак-тайп `_FakeClient` на трёх методах, которые дёргает `main`. Здесь: разбор
web_url → project, резолв репо, выбор landing-sha, пересечение веток, «прочие ветки»,
шапка/подвал MR-отчёта, обрезка title по ширине, ключ сортировки, бюджет колонки title,
оба режима команды (окно `--since` и явные адреса MR) и все сообщения об ошибках.
"""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from rich.cells import cell_len
from typer.testing import CliRunner

from mpu.commands import glab_status
from mpu.commands.glab_status import (
    COLUMNS,
    DEFAULT_REPOS,
    conflicting_window_flags,
    dedupe_targets,
    fit_title,
    format_other_branches,
    landed_columns,
    landing_sha,
    mr_header,
    mr_sort_key,
    other_branches,
    other_branches_report,
    project_from_web_url,
    repo_short_name,
    resolve_repos,
    title_budget,
)
from mpu.lib import env
from mpu.lib.gitlab_mr import GitLabAPIError, GitLabClient, MrInfo


def _mr(
    *,
    iid: int = 1,
    web_url: str = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1",
    project: str = "",
    title: str = "t",
    state: str = "merged",
    source_branch: str = "feat/x",
    target_branch: str = "dev",
    sha: str | None = None,
    merge_commit_sha: str | None = None,
    squash_commit_sha: str | None = None,
    project_id: int | None = 42,
) -> MrInfo:
    return MrInfo(
        project=project,
        iid=iid,
        title=title,
        state=state,
        source_branch=source_branch,
        target_branch=target_branch,
        web_url=web_url,
        author_name="",
        author_username="",
        description="",
        diff_refs=None,
        project_id=project_id,
        sha=sha,
        merge_commit_sha=merge_commit_sha,
        squash_commit_sha=squash_commit_sha,
    )


def _row(
    *,
    project: str = "wb/sl-back",
    iid: int = 1,
    state: str = "merged",
    source_branch: str = "feat/x",
    target_branch: str = "dev",
    other: list[str] | None = None,
) -> dict[str, Any]:
    """Минимальная строка для чистых функций отчёта (шапка/подвал)."""
    return {
        "project": project,
        "iid": iid,
        "state": state,
        "source_branch": source_branch,
        "target_branch": target_branch,
        "other_branches": other,
    }


# ── project_from_web_url ──────────────────────────────────────────────────────────


def test_project_from_web_url_ok():
    url = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1639"
    assert project_from_web_url(url) == "wb/sl-back"


def test_project_from_web_url_trailing_segments():
    url = "https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/9/diffs?tab=x"
    assert project_from_web_url(url) == "wb/sw-front"


def test_project_from_web_url_nested_group():
    url = "https://gitlab.btlz-api.ru/wb/sub/sl-back/-/merge_requests/1"
    assert project_from_web_url(url) == "wb/sub/sl-back"


@pytest.mark.parametrize("bad", ["", "https://gitlab.btlz-api.ru/", "not a url", "https://h/wb/x"])
def test_project_from_web_url_no_marker(bad: str):
    assert project_from_web_url(bad) is None


# ── repo_short_name ───────────────────────────────────────────────────────────────


def test_repo_short_name():
    assert repo_short_name("wb/sl-back") == "sl-back"
    assert repo_short_name("sl-back") == "sl-back"


# ── resolve_repos ─────────────────────────────────────────────────────────────────


def test_resolve_repos_default():
    assert resolve_repos(None) == {f"wb/{n}" for n in DEFAULT_REPOS}
    assert resolve_repos([]) == {f"wb/{n}" for n in DEFAULT_REPOS}


def test_resolve_repos_bare_names():
    assert resolve_repos(["sl-back", "sw-back"]) == {"wb/sl-back", "wb/sw-back"}


def test_resolve_repos_full_path_kept():
    assert resolve_repos(["wb/sl-back"]) == {"wb/sl-back"}


def test_resolve_repos_comma_and_mixed():
    got = resolve_repos(["sl-back, sw-back", "wb/sw-front"])
    assert got == {"wb/sl-back", "wb/sw-back", "wb/sw-front"}


# ── landing_sha ───────────────────────────────────────────────────────────────────


def test_landing_sha_merge_commit_wins():
    mr = _mr(merge_commit_sha="m", squash_commit_sha="s", sha="h")
    assert landing_sha(mr) == "m"


def test_landing_sha_squash_then_head():
    assert landing_sha(_mr(squash_commit_sha="s", sha="h")) == "s"
    assert landing_sha(_mr(sha="h")) == "h"


def test_landing_sha_none():
    assert landing_sha(_mr()) is None


# ── landed_columns ────────────────────────────────────────────────────────────────


def test_landed_columns_subset_order_preserved():
    # refs приходят в произвольном порядке — результат в порядке COLUMNS.
    assert landed_columns(["prod", "dev", "trunk"]) == ["trunk", "dev", "prod"]


def test_landed_columns_ignores_non_pipeline_branches():
    assert landed_columns(["feat/x", "main", "release/1"]) == ["main"]


def test_landed_columns_empty():
    assert landed_columns([]) == []


def test_landed_columns_covers_all():
    assert landed_columns(list(COLUMNS)) == list(COLUMNS)


# ── other_branches ────────────────────────────────────────────────────────────────


def test_other_branches_excludes_columns_and_sorts():
    got = other_branches(["prod", "qa2-branch", "dev", "Devops-pipeline"], source_branch="feat/x")
    assert got == ["Devops-pipeline", "qa2-branch"]


def test_other_branches_excludes_source_branch():
    # fast-forward без squash: landing-sha = head исходной ветки, она уже названа в шапке.
    assert other_branches(["dev", "feat/x"], source_branch="feat/x") == []


def test_other_branches_dedupes():
    assert other_branches(["x", "x", "y"], source_branch="") == ["x", "y"]


def test_other_branches_all_pipeline():
    assert other_branches(list(COLUMNS), source_branch="feat/x") == []


# ── mr_header ─────────────────────────────────────────────────────────────────────


def test_mr_header_full():
    row = _row(
        project="wb/sw-front", iid=830, source_branch="fix/67483401/rnp", target_branch="dev"
    )
    assert mr_header(row) == "wb/sw-front!830 · merged · fix/67483401/rnp → dev"


def test_mr_header_without_branches():
    # MR без коммитов: обе ветки пусты → сегмент опущен, хвостового разделителя нет.
    assert mr_header(_row(source_branch="", target_branch="")) == "wb/sl-back!1 · merged"


def test_mr_header_empty_state():
    assert mr_header(_row(state="")).split(" · ")[1] == "?"


# ── format_other_branches ─────────────────────────────────────────────────────────


def test_format_other_branches_not_merged():
    assert format_other_branches(None, "opened", full=False) == "(MR не смержен)"


def test_format_other_branches_merged_without_data():
    # merged, но refs не запрашивались (нет landing-sha / project_id) — не «не смержен».
    assert format_other_branches(None, "merged", full=False) == "(нет данных)"


def test_format_other_branches_empty():
    assert format_other_branches([], "merged", full=False) == "(нет)"


def test_format_other_branches_counter_by_default():
    names = [f"b{i}" for i in range(60)]
    assert format_other_branches(names, "merged", full=False) == "60 (показать: --branches)"


def test_format_other_branches_full_list():
    assert format_other_branches(["a", "b"], "merged", full=True) == "a, b"


# ── other_branches_report ─────────────────────────────────────────────────────────


def test_other_branches_report_single_row_is_one_line():
    rows = [_row(other=[])]
    assert other_branches_report(rows, full=False) == ["прочие ветки: (нет)"]


def test_other_branches_report_multi_row_is_block():
    rows = [
        _row(project="wb/sw-front", iid=830, other=["qa2-branch"]),
        _row(project="wb/sl-back", iid=2117, state="opened", other=None),
    ]
    assert other_branches_report(rows, full=True) == [
        "прочие ветки:",
        "  wb/sw-front!830: qa2-branch",
        "  wb/sl-back!2117: (MR не смержен)",
    ]


# ── conflicting_window_flags ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("since", "repos", "expected"),
    [
        (None, None, []),
        ("2d", None, ["--since"]),
        (None, ["sl-back"], ["--repos"]),
        ("2d", ["sl-back"], ["--since", "--repos"]),
    ],
)
def test_conflicting_window_flags(since: str | None, repos: list[str] | None, expected: list[str]):
    assert conflicting_window_flags(since, repos) == expected


# ── dedupe_targets ────────────────────────────────────────────────────────────────


def test_dedupe_targets_keeps_first_occurrence_order():
    targets = [("wb/b", 2), ("wb/a", 1), ("wb/b", 2), ("wb/a", 9)]
    assert dedupe_targets(targets) == [("wb/b", 2), ("wb/a", 1), ("wb/a", 9)]


def test_dedupe_targets_empty():
    assert dedupe_targets([]) == []


# ── fit_title ─────────────────────────────────────────────────────────────────────


def test_fit_title_short_kept():
    assert fit_title("hello", 10) == "hello"


def test_fit_title_exact_kept():
    assert fit_title("hello", 5) == "hello"


def test_fit_title_long_truncated():
    out = fit_title("abcdefghij", 5)
    assert out.endswith("…")
    assert cell_len(out) <= 5


def test_fit_title_budget_one():
    assert fit_title("abcdef", 1) == "…"


def test_fit_title_budget_zero_or_negative():
    assert fit_title("abc", 0) == ""
    assert fit_title("abc", -3) == ""


def test_fit_title_wide_glyphs_respect_cells():
    # ✅ — 2 терминальные ячейки; обрезка должна считать по ячейкам, не по len.
    out = fit_title("✅✅✅✅", 5)
    assert out.endswith("…")
    assert cell_len(out) <= 5


# ── mr_sort_key ───────────────────────────────────────────────────────────────────


def test_mr_sort_key_by_repo_then_iid():
    a = _mr(iid=10, web_url="https://h/wb/sw-back/-/merge_requests/10")
    b = _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2")
    c = _mr(iid=1, web_url="https://h/wb/sw-back/-/merge_requests/1")
    assert sorted([a, b, c], key=mr_sort_key) == [b, c, a]


def test_mr_sort_key_fallback_to_project_field():
    # web_url без маркера → берём mr.project.
    mr = _mr(web_url="garbage", project="wb/sl-back")
    assert mr_sort_key(mr) == ("sl-back", 1)


# ── title_budget ──────────────────────────────────────────────────────────────────


def test_title_budget_subtracts_fixed_and_chrome():
    rows: list[dict[str, Any]] = [{"repo": "sl-back", "iid": 1639, "title": "x", "landed": []}]
    # chrome = 3*9+1 = 28; branches = 5+4+3+2+8+4 = 26; repo=7; id=4.
    assert title_budget(200, rows) == 200 - 28 - 26 - 7 - 4


# ── main (CLI handler через CliRunner + фейк-клиент) ───────────────────────────────

runner = CliRunner()

# Голое число parse_since принимает как unix-ts → детерминированный _iso_utc в тестах.
_FIXED_TS = 1700000000


def _iso(ts: int) -> str:
    """Ожидаемый результат `_iso_utc(ts)` — продублирован, чтобы не импортировать
    приватный хелпер (как в существующих тестах — только публичный API модуля)."""
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class _FakeClient:
    """Замена GitLabClient на трёх сетевых вызовах, которые дёргает `main`.

    Записывает аргументы вызовов (для проверки обёртки `_iso_utc` и того, что у
    открытых / отфильтрованных MR refs не запрашиваются) и умеет бросать
    GitLabAPIError на любом из путей. `base_url`/`host` нужны резолву адреса MR.
    """

    base_url = "https://gitlab.btlz-api.ru"
    host = "gitlab.btlz-api.ru"

    def __init__(
        self,
        mrs: list[MrInfo],
        *,
        refs_by_sha: dict[str, list[str]] | None = None,
        mrs_by_target: dict[tuple[str, int], MrInfo] | None = None,
        list_error: GitLabAPIError | None = None,
        refs_error: GitLabAPIError | None = None,
        get_error: GitLabAPIError | None = None,
    ) -> None:
        self._mrs = mrs
        self._refs_by_sha: dict[str, list[str]] = refs_by_sha or {}
        self._mrs_by_target: dict[tuple[str, int], MrInfo] = mrs_by_target or {}
        self._list_error = list_error
        self._refs_error = refs_error
        self._get_error = get_error
        self.list_calls: list[str] = []
        self.refs_calls: list[tuple[int, str]] = []
        self.get_calls: list[tuple[str, int]] = []

    def list_my_merge_requests(self, updated_after_iso: str) -> list[MrInfo]:
        self.list_calls.append(updated_after_iso)
        if self._list_error is not None:
            raise self._list_error
        return self._mrs

    def commit_branch_names(self, project_id: int, sha: str) -> list[str]:
        self.refs_calls.append((project_id, sha))
        if self._refs_error is not None:
            raise self._refs_error
        return self._refs_by_sha.get(sha, [])

    def get_mr(self, project: str, iid: int) -> MrInfo:
        self.get_calls.append((project, iid))
        if self._get_error is not None:
            raise self._get_error
        return self._mrs_by_target[(project, iid)]


def _use_client(monkeypatch: pytest.MonkeyPatch, client: _FakeClient) -> None:
    """Подменить `_client()` фейком (минуя GitLabClient.from_env / сеть)."""
    monkeypatch.setattr(glab_status, "_client", lambda: client)


def _install_git(
    monkeypatch: pytest.MonkeyPatch,
    *,
    remote: str = "ssh://git@gitlab.btlz-api.ru:2222/wb/sw-front.git",
    error: Exception | None = None,
) -> list[list[str]]:
    """Подменить `git` (паттерн tests/test_mr.py); возвращает журнал вызовов."""
    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool = False,
        text: bool = False,
        check: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        _ = (capture_output, text, check)
        calls.append(args)
        if error is not None:
            raise error
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=remote + "\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_cli_json_states_sort_and_landed(monkeypatch: pytest.MonkeyPatch) -> None:
    # closed (вне VISIBLE_STATES) и репо вне дефолтного набора должны отфильтроваться;
    # порядок строк — (короткое имя репо, iid).
    mrs = [
        _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2"),
        _mr(iid=5, web_url="https://h/wb/sl-back/-/merge_requests/5").model_copy(
            update={"state": "opened"}
        ),
        _mr(iid=1, web_url="https://h/wb/sw-back/-/merge_requests/1", merge_commit_sha="m1"),
        _mr(iid=9, web_url="https://h/wb/sl-back/-/merge_requests/9").model_copy(
            update={"state": "closed"}
        ),
        _mr(iid=7, web_url="https://h/wb/other/-/merge_requests/7", merge_commit_sha="mx"),
    ]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["dev", "main", "feat/z"], "m1": list(COLUMNS)})
    _use_client(monkeypatch, client)

    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert res.exit_code == 0
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert [(r["repo"], r["iid"], r["state"]) for r in rows] == [
        ("sl-back", 2, "merged"),
        ("sl-back", 5, "opened"),
        ("sw-back", 1, "merged"),
    ]
    # landed в порядке COLUMNS; у открытого — пусто; у полностью долетевшего — все колонки.
    assert rows[0]["landed"] == ["main", "dev"]
    assert rows[1]["landed"] == []
    assert rows[2]["landed"] == list(COLUMNS)
    # окно прокинуто через _iso_utc; refs запрошены только у смерженных в выбранных репо
    # (open / closed / чужой репо — без запроса).
    assert client.list_calls == [_iso(_FIXED_TS)]
    assert client.refs_calls == [(42, "m2"), (42, "m1")]


def test_cli_json_squash_commit_used_for_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    # merge_commit нет → landing-sha = squash_commit, по нему и запрашиваются ветки.
    mr = _mr(iid=3, web_url="https://h/wb/sw-back/-/merge_requests/3", squash_commit_sha="sq")
    client = _FakeClient([mr], refs_by_sha={"sq": ["dev"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert res.exit_code == 0
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert rows[0]["landed"] == ["dev"]
    assert client.refs_calls == [(42, "sq")]


def test_cli_repos_single_excludes_others(monkeypatch: pytest.MonkeyPatch) -> None:
    mrs = [
        _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2"),
        _mr(iid=1, web_url="https://h/wb/sw-back/-/merge_requests/1", merge_commit_sha="m1"),
    ]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["dev"], "m1": ["dev"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(
        glab_status.app, ["--since", str(_FIXED_TS), "--repos", "sl-back", "--json"]
    )
    assert res.exit_code == 0
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert [r["repo"] for r in rows] == ["sl-back"]
    # отфильтрованный sw-back до запроса refs не доходит
    assert client.refs_calls == [(42, "m2")]


def test_cli_repos_comma_and_repeat_equivalent(monkeypatch: pytest.MonkeyPatch) -> None:
    mrs = [
        _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2"),
        _mr(iid=1, web_url="https://h/wb/sw-back/-/merge_requests/1", merge_commit_sha="m1"),
    ]
    refs = {"m2": ["dev"], "m1": ["dev"]}
    _use_client(monkeypatch, _FakeClient(mrs, refs_by_sha=refs))
    comma = runner.invoke(
        glab_status.app, ["--since", str(_FIXED_TS), "--repos", "sl-back,sw-back", "--json"]
    )
    _use_client(monkeypatch, _FakeClient(mrs, refs_by_sha=refs))
    repeat = runner.invoke(
        glab_status.app,
        ["--since", str(_FIXED_TS), "--repos", "sl-back", "--repos", "sw-back", "--json"],
    )
    assert comma.exit_code == 0
    assert repeat.exit_code == 0
    assert comma.stdout == repeat.stdout
    parsed: list[dict[str, Any]] = json.loads(comma.stdout)
    assert [r["repo"] for r in parsed] == ["sl-back", "sw-back"]


def test_cli_table_render(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    mrs = [_mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2")]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["main", "dev"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 0
    assert "sl-back" in res.stdout
    assert glab_status.CHECK in res.stdout  # хотя бы одна галочка отрисована


def test_cli_table_truncates_long_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "80")
    long_title = "A" * 60
    mr = _mr(
        iid=1, web_url="https://h/wb/sl-back/-/merge_requests/1", merge_commit_sha="m1"
    ).model_copy(update={"title": long_title})
    client = _FakeClient([mr], refs_by_sha={"m1": ["dev"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 0
    assert "…" in res.stdout  # title обрезан под доступную ширину
    assert long_title not in res.stdout  # целиком не помещается


def test_cli_since_parse_error(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient([])
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", "garbage"])
    assert res.exit_code == 1
    assert "--since" in res.output
    assert client.list_calls == []  # до запроса MR не дошли


def test_cli_list_error_401_hints_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "env_path", lambda: Path("/fake/cfg/.env"))
    err = GitLabAPIError("GET", "/merge_requests", 401, "unauthorized")
    client = _FakeClient([], list_error=err)
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" in res.output
    assert "/fake/cfg/.env" in res.output


def test_cli_list_error_500_plain(monkeypatch: pytest.MonkeyPatch) -> None:
    err = GitLabAPIError("GET", "/merge_requests", 500, "boom")
    client = _FakeClient([], list_error=err)
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 1
    assert "gitlab error" in res.output
    assert "GLAB_TOKEN" not in res.output  # 401-подсказки на не-401 нет


def test_cli_build_rows_error(monkeypatch: pytest.MonkeyPatch) -> None:
    err = GitLabAPIError("GET", "/refs", 500, "boom")
    mrs = [_mr(iid=1, web_url="https://h/wb/sl-back/-/merge_requests/1", merge_commit_sha="m1")]
    client = _FakeClient(mrs, refs_error=err)
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 1
    assert "gitlab error" in res.output


def test_cli_empty_table_message(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient([])
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 0
    assert "нет моих MR" in res.output


def test_cli_empty_json_is_empty_list(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient([])
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert res.exit_code == 0
    assert json.loads(res.stdout) == []


def test_cli_missing_token_runtime_error(monkeypatch: pytest.MonkeyPatch) -> None:
    # _client ловит RuntimeError из from_env (нет GLAB_TOKEN) → _fail.
    def _no_token() -> GitLabClient:
        raise RuntimeError("environment variable GLAB_TOKEN is not set")

    monkeypatch.setattr(glab_status.GitLabClient, "from_env", _no_token)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" in res.output


def test_cli_client_from_env_success(monkeypatch: pytest.MonkeyPatch) -> None:
    # _client не подменяем — он реально вызывает from_env (фейк) и возвращает его.
    client = _FakeClient([])
    monkeypatch.setattr(glab_status.GitLabClient, "from_env", lambda: client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert res.exit_code == 0
    assert json.loads(res.stdout) == []
    assert client.list_calls == [_iso(_FIXED_TS)]


def test_cli_default_since_window(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient([])
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--json"])
    assert res.exit_code == 0
    assert json.loads(res.stdout) == []
    # дефолт 7d → ровно одно окно в ISO-формате
    assert len(client.list_calls) == 1
    assert client.list_calls[0].endswith("Z")


def test_cli_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    mrs = [_mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2")]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["dev"]})
    _use_client(monkeypatch, client)
    first = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    second = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert first.exit_code == 0
    assert second.exit_code == 0
    assert first.stdout == second.stdout


def test_resolve_repos_skips_empty_parts() -> None:
    # хвостовая запятая / пустые сегменты после split(",") отбрасываются
    assert resolve_repos(["sl-back,", " , "]) == {"wb/sl-back"}


# ── main: режим явных адресов MR ──────────────────────────────────────────────────

_SW_FRONT_MR = ("wb/sw-front", 830)


def _mr_client(*, extra: dict[tuple[str, int], MrInfo] | None = None, **kwargs: Any) -> _FakeClient:
    """Фейк для MR-режима: один смерженный MR sw-front!830 с одной «прочей» веткой."""
    mr = _mr(
        iid=830,
        web_url="https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/830",
        title="RNP to Checklist",
        source_branch="fix/67483401/rnp",
        merge_commit_sha="m830",
    )
    defaults: dict[str, Any] = {
        "mrs_by_target": {_SW_FRONT_MR: mr, **(extra or {})},
        "refs_by_sha": {"m830": ["dev", "qa2-branch"]},
    }
    defaults.update(kwargs)
    return _FakeClient([], **defaults)


def test_cli_mr_single_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    client = _mr_client()
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!830"])
    assert res.exit_code == 0
    lines = res.stdout.splitlines()
    assert lines[0] == "wb/sw-front!830 · merged · fix/67483401/rnp → dev"
    assert lines[1] == ""
    assert lines[-1] == "прочие ветки: 1 (показать: --branches)"
    assert any(glab_status.CHECK in line and "sw-front" in line for line in lines)
    # окно не запрашивается, refs — по landing-sha
    assert client.get_calls == [_SW_FRONT_MR]
    assert client.list_calls == []
    assert client.refs_calls == [(42, "m830")]


def test_cli_mr_branches_flag_expands_list(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "--branches"])
    assert res.exit_code == 0
    assert res.stdout.splitlines()[-1] == "прочие ветки: qa2-branch"


def test_cli_mr_by_url(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mr_client()
    _use_client(monkeypatch, client)
    url = "https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/830/diffs"
    res = runner.invoke(glab_status.app, [url, "--json"])
    assert res.exit_code == 0
    assert client.get_calls == [_SW_FRONT_MR]


def test_cli_mr_bare_iid_uses_cwd_remote(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install_git(monkeypatch)
    client = _mr_client()
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["830", "--json"])
    assert res.exit_code == 0
    assert client.get_calls == [_SW_FRONT_MR]
    # ветка текущего каталога не нужна — только remote (в отличие от `mpu mr`)
    assert calls == [["git", "remote", "get-url", "origin"]]


def test_cli_mr_dedupes_same_target(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    _install_git(monkeypatch)
    client = _mr_client()
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["830", "wb/sw-front!830"])
    assert res.exit_code == 0
    assert client.get_calls == [_SW_FRONT_MR]
    assert res.stdout.count("wb/sw-front!830 · merged") == 1


def test_cli_mr_multiple_projects_one_table(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    other = _mr(
        iid=2117,
        web_url="https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/2117",
        state="opened",
        source_branch="fix/jobs/rollover",
        target_branch="main",
        project_id=7,
    )
    client = _mr_client(extra={("wb/sl-back", 2117): other})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "wb/sl-back!2117"])
    assert res.exit_code == 0
    lines = res.stdout.splitlines()
    # порядок аргументов, а не (репо, id): sw-front перед sl-back
    assert lines[0].startswith("wb/sw-front!830")
    assert lines[1].startswith("wb/sl-back!2117 · opened")
    assert lines[-3:] == [
        "прочие ветки:",
        "  wb/sw-front!830: 1 (показать: --branches)",
        "  wb/sl-back!2117: (MR не смержен)",
    ]
    # у открытого MR refs не запрашиваются
    assert client.refs_calls == [(42, "m830")]


def test_cli_mr_json_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "--json"])
    assert res.exit_code == 0
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert list(rows[0]) == [
        "repo",
        "iid",
        "title",
        "state",
        "web_url",
        "landed",
        "project",
        "source_branch",
        "target_branch",
        "other_branches",
    ]
    assert rows[0]["landed"] == ["dev"]
    assert rows[0]["other_branches"] == ["qa2-branch"]
    assert rows[0]["project"] == "wb/sw-front"


def test_cli_mr_closed_is_shown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    closed = _mr(
        iid=9,
        web_url="https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/9",
        state="closed",
        merge_commit_sha="m9",
    )
    client = _FakeClient([], mrs_by_target={("wb/sw-front", 9): closed})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!9"])
    assert res.exit_code == 0
    assert res.stdout.splitlines()[0].split(" · ")[1] == "closed"
    assert res.stdout.splitlines()[-1] == "прочие ветки: (MR не смержен)"
    assert client.refs_calls == []


def test_cli_mr_merged_without_landing_sha(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    bare = _mr(
        iid=5,
        web_url="https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/5",
        project_id=None,
    )
    client = _FakeClient([], mrs_by_target={("wb/sw-front", 5): bare})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!5", "--json"])
    assert res.exit_code == 0
    assert client.refs_calls == []
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert rows[0]["landed"] == []
    assert rows[0]["other_branches"] is None
    # merged без данных не должен объявляться несмерженным
    assert format_other_branches(None, "merged", full=False) == "(нет данных)"


def test_cli_mr_foreign_repo_is_shown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    foreign = _mr(
        iid=7,
        web_url="https://gitlab.btlz-api.ru/other-group/some-repo/-/merge_requests/7",
        merge_commit_sha="m7",
    )
    client = _FakeClient(
        [],
        mrs_by_target={("other-group/some-repo", 7): foreign},
        refs_by_sha={"m7": ["release"]},
    )
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["other-group/some-repo!7"])
    assert res.exit_code == 0
    assert res.stdout.splitlines()[0].startswith("other-group/some-repo!7")


def test_cli_mr_markup_is_not_interpreted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "200")
    evil = _mr(
        iid=830,
        web_url="https://gitlab.btlz-api.ru/wb/sw-front/-/merge_requests/830",
        title="[fix]: x",
        source_branch="[i]src",
        merge_commit_sha="m830",
    )
    client = _FakeClient(
        [],
        mrs_by_target={_SW_FRONT_MR: evil},
        refs_by_sha={"m830": ["[bold red]evil"]},
    )
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "--branches"])
    assert res.exit_code == 0
    assert "[i]src" in res.stdout
    assert "[fix]: x" in res.stdout
    assert "[bold red]evil" in res.stdout


def test_cli_mr_narrow_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "40")
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["wb/sw-front!830"])
    assert res.exit_code == 0
    # шапка не обрезается по ширине таблицы
    assert res.stdout.splitlines()[0].endswith("→ dev")


def test_cli_mr_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    _use_client(monkeypatch, _mr_client())
    first = runner.invoke(glab_status.app, ["wb/sw-front!830"])
    _use_client(monkeypatch, _mr_client())
    second = runner.invoke(glab_status.app, ["wb/sw-front!830"])
    assert first.stdout == second.stdout


# ── main: ошибки MR-режима ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("args", "expected_flags"),
    [
        (["wb/sw-front!830", "--since", "2d"], "--since"),
        (["wb/sw-front!830", "--repos", "sl-back"], "--repos"),
        (["wb/sw-front!830", "--since", "2d", "--repos", "sl-back"], "--since/--repos"),
    ],
)
def test_cli_mr_window_flags_conflict(
    monkeypatch: pytest.MonkeyPatch, args: list[str], expected_flags: str
) -> None:
    client = _mr_client()
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, args)
    assert res.exit_code == 1
    assert res.stderr.strip() == (
        f"mpu glab-status: {expected_flags} — только для режима «мои MR», "
        f"с адресом MR не сочетается; попробуй: убрать {expected_flags} "
        "либо вызвать mpu glab-status без адресов MR"
    )
    assert client.get_calls == []
    assert client.list_calls == []


def test_cli_mr_conflict_checked_before_token(monkeypatch: pytest.MonkeyPatch) -> None:
    # usage-ошибка не должна требовать GLAB_TOKEN
    def _no_token() -> GitLabClient:
        raise RuntimeError("environment variable GLAB_TOKEN is not set")

    monkeypatch.setattr(GitLabClient, "from_env", _no_token)
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "--since", "2d"])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" not in res.stderr
    assert "--since" in res.stderr


def test_cli_branches_without_mr_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeClient([])
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--branches"])
    assert res.exit_code == 1
    assert res.stderr.strip() == (
        "mpu glab-status: --branches применяется только с адресом MR; "
        "попробуй: указать адрес MR либо убрать флаг"
    )
    assert client.list_calls == []


def test_cli_mr_garbage_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mr_client()
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["garbage"])
    assert res.exit_code == 1
    assert "не удалось разобрать MR 'garbage'" in res.stderr
    # у команды нет флага --mr — подсказка не должна его упоминать
    assert "--mr" not in res.stderr
    assert client.get_calls == []


def test_cli_mr_foreign_host_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["https://gitlab.com/wb/x/-/merge_requests/1"])
    assert res.exit_code == 1
    assert "хост MR-URL 'gitlab.com'" in res.stderr


def test_cli_mr_bare_iid_outside_git_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    err = subprocess.CalledProcessError(128, ["git"], stderr="fatal: not a git repository")
    _install_git(monkeypatch, error=err)
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["830"])
    assert res.exit_code == 1
    # виновный аргумент назван — иначе при нескольких MR не найти, какой резолвился
    assert "MR '830': fatal: not a git repository" in res.stderr
    assert "укажи MR как 'group/repo!iid' или полным URL" in res.stderr
    assert "--mr" not in res.stderr
    assert res.stdout == ""


def test_cli_mr_git_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_git(monkeypatch, error=FileNotFoundError())
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["830"])
    assert res.exit_code == 1
    assert "git не найден в PATH" in res.stderr


def test_cli_mr_remote_on_foreign_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_git(monkeypatch, remote="git@github.com-work:me/mpu.git")
    _use_client(monkeypatch, _mr_client())
    res = runner.invoke(glab_status.app, ["830"])
    assert res.exit_code == 1
    assert "github.com-work" in res.stderr
    assert "--mr" not in res.stderr


def test_cli_mr_404_hints_address(monkeypatch: pytest.MonkeyPatch) -> None:
    err = GitLabAPIError("GET", "/merge_requests/9", 404, "not found")
    _use_client(monkeypatch, _mr_client(get_error=err))
    res = runner.invoke(glab_status.app, ["wb/sw-front!9"])
    assert res.exit_code == 1
    assert "проверь адрес MR" in res.stderr
    assert res.stdout == ""


def test_cli_mr_401_hints_token(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(env, "env_path", lambda: tmp_path / ".env")
    err = GitLabAPIError("GET", "/merge_requests/830", 401, "unauthorized")
    _use_client(monkeypatch, _mr_client(get_error=err))
    res = runner.invoke(glab_status.app, ["wb/sw-front!830"])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" in res.stderr
    assert "проверь адрес MR" not in res.stderr


def test_cli_mr_second_mr_fails_prints_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    # частичный вывод хуже пустого: ни шапки первого MR, ни обрезанного JSON
    err = GitLabAPIError("GET", "/merge_requests/2117", 500, "boom")
    client = _mr_client(get_error=err)
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["wb/sw-front!830", "wb/sl-back!2117", "--json"])
    assert res.exit_code == 1
    assert res.stdout == ""


# ── main: регрессия оконного режима ───────────────────────────────────────────────


def test_cli_window_json_has_new_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    mrs = [
        _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2"),
        _mr(iid=5, web_url="https://h/wb/sl-back/-/merge_requests/5", state="opened"),
    ]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["dev", "feat/z"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS), "--json"])
    assert res.exit_code == 0
    rows: list[dict[str, Any]] = json.loads(res.stdout)
    assert rows[0]["landed"] == ["dev"]
    assert rows[0]["other_branches"] == ["feat/z"]
    assert rows[0]["project"] == "wb/sl-back"
    assert rows[0]["source_branch"] == "feat/x"
    assert rows[0]["target_branch"] == "dev"
    # у открытого refs не запрашивались — «не знаем», а не «пусто»
    assert rows[1]["other_branches"] is None


def test_cli_window_has_no_mr_report(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "120")
    mrs = [_mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2")]
    client = _FakeClient(mrs, refs_by_sha={"m2": ["dev", "feat/z"]})
    _use_client(monkeypatch, client)
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 0
    assert "прочие ветки" not in res.stdout
    assert "wb/sl-back!2 · merged" not in res.stdout


def test_cli_window_404_does_not_hint_mr_address(monkeypatch: pytest.MonkeyPatch) -> None:
    err = GitLabAPIError("GET", "/merge_requests", 404, "not found")
    _use_client(monkeypatch, _FakeClient([], list_error=err))
    res = runner.invoke(glab_status.app, ["--since", str(_FIXED_TS)])
    assert res.exit_code == 1
    # адрес MR пользователь не вводил — подсказка про него была бы шумом
    assert "проверь адрес MR" not in res.stderr
