"""Тесты `mpu glab-status` — только чистые функции (без сети, без HTTP-моков).

I/O (GitLabClient, list_my_merge_requests, commit_branch_names) тестами не покрыт —
прецедент mr/kaiten. Здесь: разбор web_url → project, резолв репо, выбор landing-sha,
пересечение веток, обрезка title по ширине, ключ сортировки, бюджет колонки title.
"""

from __future__ import annotations

from typing import Any

import pytest
from rich.cells import cell_len

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
from mpu.lib.gitlab_mr import MrInfo


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
