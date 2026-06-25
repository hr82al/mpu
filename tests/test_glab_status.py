"""Тесты `mpu glab-status` — только чистые функции (без сети, без HTTP-моков).

I/O (GitLabClient, list_my_merge_requests, commit_branch_names) тестами не покрыт —
прецедент mr/kaiten. Здесь: разбор web_url → project, резолв репо, выбор landing-sha,
пересечение веток, обрезка title по ширине, ключ сортировки, бюджет колонки title.
"""

from __future__ import annotations

import json
from dataclasses import replace
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
    fit_title,
    landed_columns,
    landing_sha,
    mr_sort_key,
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
    sha: str | None = None,
    merge_commit_sha: str | None = None,
    squash_commit_sha: str | None = None,
) -> MrInfo:
    return MrInfo(
        project=project,
        iid=iid,
        title="t",
        state="merged",
        source_branch="feat/x",
        target_branch="dev",
        web_url=web_url,
        author_name="",
        author_username="",
        description="",
        diff_refs=None,
        project_id=42,
        sha=sha,
        merge_commit_sha=merge_commit_sha,
        squash_commit_sha=squash_commit_sha,
    )


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
    """Замена GitLabClient на двух сетевых вызовах, которые дёргает `main`.

    Записывает аргументы вызовов (для проверки обёртки `_iso_utc` и того, что у
    открытых / отфильтрованных MR refs не запрашиваются) и умеет бросать
    GitLabAPIError на любом из двух путей.
    """

    def __init__(
        self,
        mrs: list[MrInfo],
        *,
        refs_by_sha: dict[str, list[str]] | None = None,
        list_error: GitLabAPIError | None = None,
        refs_error: GitLabAPIError | None = None,
    ) -> None:
        self._mrs = mrs
        self._refs_by_sha: dict[str, list[str]] = refs_by_sha or {}
        self._list_error = list_error
        self._refs_error = refs_error
        self.list_calls: list[str] = []
        self.refs_calls: list[tuple[int, str]] = []

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


def _use_client(monkeypatch: pytest.MonkeyPatch, client: _FakeClient) -> None:
    """Подменить `_client()` фейком (минуя GitLabClient.from_env / сеть)."""
    monkeypatch.setattr(glab_status, "_client", lambda: client)


def test_cli_json_states_sort_and_landed(monkeypatch: pytest.MonkeyPatch) -> None:
    # closed (вне VISIBLE_STATES) и репо вне дефолтного набора должны отфильтроваться;
    # порядок строк — (короткое имя репо, iid).
    mrs = [
        _mr(iid=2, web_url="https://h/wb/sl-back/-/merge_requests/2", merge_commit_sha="m2"),
        replace(_mr(iid=5, web_url="https://h/wb/sl-back/-/merge_requests/5"), state="opened"),
        _mr(iid=1, web_url="https://h/wb/sw-back/-/merge_requests/1", merge_commit_sha="m1"),
        replace(_mr(iid=9, web_url="https://h/wb/sl-back/-/merge_requests/9"), state="closed"),
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
    mr = replace(
        _mr(iid=1, web_url="https://h/wb/sl-back/-/merge_requests/1", merge_commit_sha="m1"),
        title=long_title,
    )
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
