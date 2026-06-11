"""Тесты `mpu/lib/gitlab_mr.py` — только чистые функции (без сети и без моков HTTP).

I/O-клиент `GitLabClient` тестами не покрыт — прецедент kaiten/miro/slapi. Здесь:
парсинг селектора MR и git remote, line-mapping unified-diff, сборка
position-параметров, резолв дискуссии по префиксу и фильтры тредов.
"""

from __future__ import annotations

import pytest

from mpu.lib.gitlab_mr import (
    DiffLine,
    DiffRefs,
    Discussion,
    FileDiff,
    Note,
    NotePosition,
    build_position_params,
    commentable_ranges,
    encode_project,
    filter_discussions,
    find_diff_line,
    format_ranges,
    match_discussion,
    note_url,
    parse_discussion,
    parse_file_diff,
    parse_mr_info,
    parse_mr_ref,
    parse_unified_diff,
    project_from_remote_url,
)

BASE_URL = "https://gitlab.btlz-api.ru"


# ── parse_mr_ref ────────────────────────────────────────────────────────────────


def test_parse_mr_ref_url():
    ref = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1499"
    assert parse_mr_ref(ref, BASE_URL) == ("wb/sl-back", 1499)


def test_parse_mr_ref_url_with_tail_and_query():
    ref = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1499/diffs?tab=diffs#note_1"
    assert parse_mr_ref(ref, BASE_URL) == ("wb/sl-back", 1499)
    ref_slash = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1499/"
    assert parse_mr_ref(ref_slash, BASE_URL) == ("wb/sl-back", 1499)


def test_parse_mr_ref_url_nested_group():
    ref = "https://gitlab.btlz-api.ru/a/b/c/-/merge_requests/12"
    assert parse_mr_ref(ref, BASE_URL) == ("a/b/c", 12)


def test_parse_mr_ref_url_foreign_host():
    with pytest.raises(ValueError, match="хост"):
        parse_mr_ref("https://gitlab.com/wb/sl-back/-/merge_requests/1", BASE_URL)


def test_parse_mr_ref_bang_form():
    assert parse_mr_ref("wb/sl-back!1499", BASE_URL) == ("wb/sl-back", 1499)
    assert parse_mr_ref("a/b/c!12", BASE_URL) == ("a/b/c", 12)


def test_parse_mr_ref_bare_iid():
    assert parse_mr_ref("1499", BASE_URL) == (None, 1499)


@pytest.mark.parametrize("bad", ["", "abc", "wb/sl-back!", "!12", "wb/sl-back!x"])
def test_parse_mr_ref_garbage(bad: str):
    with pytest.raises(ValueError):
        parse_mr_ref(bad, BASE_URL)


# ── project_from_remote_url ─────────────────────────────────────────────────────

HOST = "gitlab.btlz-api.ru"


def test_remote_ssh_with_port():
    url = "ssh://git@gitlab.btlz-api.ru:2222/wb/sl-back.git"
    assert project_from_remote_url(url, HOST) == "wb/sl-back"


def test_remote_scp_form():
    assert project_from_remote_url("git@gitlab.btlz-api.ru:wb/sl-back.git", HOST) == "wb/sl-back"


def test_remote_https_and_no_git_suffix():
    assert project_from_remote_url("https://gitlab.btlz-api.ru/wb/sl-back.git", HOST) == (
        "wb/sl-back"
    )
    assert project_from_remote_url("https://gitlab.btlz-api.ru/wb/sl-back", HOST) == "wb/sl-back"


def test_remote_foreign_host_mentions_actual():
    with pytest.raises(ValueError, match=r"github\.com-work"):
        project_from_remote_url("git@github.com-work:hr82al/mpu.git", HOST)


def test_encode_project():
    assert encode_project("wb/sl-back") == "wb%2Fsl-back"


def test_note_url():
    assert note_url("https://x/wb/sl-back/-/merge_requests/1", 17209).endswith("#note_17209")


# ── parse_unified_diff / find_diff_line / commentable_ranges ────────────────────

MIXED_DIFF = "@@ -10,4 +10,5 @@ def f():\n ctx10\n-old11\n+new11\n+new12\n ctx13\n"


def test_parse_unified_diff_mixed_hunk():
    lines = parse_unified_diff(MIXED_DIFF)
    assert lines == [
        DiffLine("context", 10, 10),
        DiffLine("removed", 11, None),
        DiffLine("added", None, 11),
        DiffLine("added", None, 12),
        DiffLine("context", 12, 13),
    ]


def test_parse_unified_diff_multi_hunk_and_no_newline():
    diff = (
        "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -100,1 +100,2 @@\n x\n+y\n\\ No newline at end of file\n"
    )
    lines = parse_unified_diff(diff)
    assert DiffLine("context", 100, 100) in lines
    assert DiffLine("added", None, 101) in lines
    assert all(line.kind in ("added", "removed", "context") for line in lines)


def test_parse_unified_diff_new_file_and_binary():
    new_file = "@@ -0,0 +1,2 @@\n+one\n+two\n"
    assert parse_unified_diff(new_file) == [
        DiffLine("added", None, 1),
        DiffLine("added", None, 2),
    ]
    assert parse_unified_diff("") == []


def test_parse_unified_diff_empty_context_line():
    # Пустая контекстная строка приходит как "" (без " "-префикса).
    lines = parse_unified_diff("@@ -1,3 +1,3 @@\n a\n\n b\n")
    assert lines[1] == DiffLine("context", 2, 2)


def test_find_diff_line_sides():
    lines = parse_unified_diff(MIXED_DIFF)
    assert find_diff_line(lines, line=11, side="new") == DiffLine("added", None, 11)
    assert find_diff_line(lines, line=10, side="new") == DiffLine("context", 10, 10)
    assert find_diff_line(lines, line=11, side="old") == DiffLine("removed", 11, None)
    assert find_diff_line(lines, line=999, side="new") is None


def test_commentable_ranges_and_format():
    lines = [
        DiffLine("added", None, 5),
        DiffLine("added", None, 6),
        DiffLine("context", 1, 7),
        DiffLine("added", None, 100),
        DiffLine("removed", 50, None),
    ]
    assert commentable_ranges(lines, "new") == [(5, 7), (100, 100)]
    assert commentable_ranges(lines, "old") == [(1, 1), (50, 50)]
    assert format_ranges([(5, 7), (100, 100)]) == "5-7, 100"
    assert commentable_ranges([], "new") == []


# ── build_position_params ───────────────────────────────────────────────────────

REFS = DiffRefs(base_sha="b" * 40, start_sha="s" * 40, head_sha="h" * 40)
FILE = FileDiff(
    old_path="src/old.js",
    new_path="src/new.js",
    diff="",
    new_file=False,
    renamed_file=True,
    deleted_file=False,
)


def test_position_params_added_line():
    params = build_position_params(REFS, FILE, DiffLine("added", None, 64))
    assert params["position[position_type]"] == "text"
    assert params["position[base_sha]"] == "b" * 40
    assert params["position[start_sha]"] == "s" * 40
    assert params["position[head_sha]"] == "h" * 40
    assert params["position[new_line]"] == "64"
    assert "position[old_line]" not in params
    # rename: оба пути присутствуют и различаются
    assert params["position[old_path]"] == "src/old.js"
    assert params["position[new_path]"] == "src/new.js"


def test_position_params_context_line_has_both():
    params = build_position_params(REFS, FILE, DiffLine("context", 60, 64))
    assert params["position[new_line]"] == "64"
    assert params["position[old_line]"] == "60"


def test_position_params_removed_line():
    params = build_position_params(REFS, FILE, DiffLine("removed", 60, None))
    assert params["position[old_line]"] == "60"
    assert "position[new_line]" not in params


# ── match_discussion / filter_discussions ───────────────────────────────────────


def _note(
    note_id: int = 1,
    *,
    system: bool = False,
    resolvable: bool = True,
    resolved: bool = False,
    author: str = "hr82al",
    name: str = "Александр",
    position: NotePosition | None = None,
) -> Note:
    return Note(
        id=note_id,
        body=f"note {note_id}",
        author_name=name,
        author_username=author,
        created_at=None,
        updated_at=None,
        system=system,
        resolvable=resolvable,
        resolved=resolved,
        type=None,
        position=position,
    )


def _discussion(disc_id: str, *notes: Note) -> Discussion:
    return Discussion(id=disc_id, individual_note=False, notes=list(notes))


def test_match_discussion_exact_and_prefix():
    discs = [_discussion("a" * 40, _note()), _discussion("b" * 40, _note())]
    assert match_discussion(discs, "a" * 40).id == "a" * 40
    assert match_discussion(discs, "AAAAAA").id == "a" * 40  # регистронезависимо


def test_match_discussion_errors():
    discs = [_discussion("abc123" + "0" * 34, _note()), _discussion("abc124" + "0" * 34, _note())]
    with pytest.raises(ValueError, match="короче"):
        match_discussion(discs, "abc12")
    with pytest.raises(ValueError, match="не найден"):
        match_discussion(discs, "ffffff")


def test_match_discussion_ambiguous_prefix():
    discs = [_discussion("abcdef1" + "0" * 33, _note()), _discussion("abcdef2" + "0" * 33, _note())]
    with pytest.raises(ValueError, match="неоднозначен"):
        match_discussion(discs, "abcdef")


def test_filter_discussions_drops_system_and_empty():
    discs = [
        _discussion("a" * 40, _note(1, system=True)),
        _discussion("b" * 40, _note(2, system=True), _note(3)),
    ]
    filtered = filter_discussions(discs)
    assert [d.id for d in filtered] == ["b" * 40]
    assert [n.id for n in filtered[0].notes] == [3]


def test_filter_discussions_unresolved():
    discs = [
        _discussion("a" * 40, _note(1, resolved=True)),
        _discussion("b" * 40, _note(2, resolved=False)),
        _discussion("c" * 40, _note(3, resolvable=False)),  # general — нечего резолвить
    ]
    assert [d.id for d in filter_discussions(discs, unresolved=True)] == ["b" * 40]


def test_filter_discussions_file_and_author():
    pos = NotePosition(old_path="src/a.ts", new_path="src/a.ts", old_line=None, new_line=5)
    discs = [
        _discussion("a" * 40, _note(1, position=pos)),
        _discussion("b" * 40, _note(2, author="kalabass", name="Сергей")),
    ]
    assert [d.id for d in filter_discussions(discs, file="a.ts")] == ["a" * 40]
    assert filter_discussions(discs, file="nope.ts") == []
    assert [d.id for d in filter_discussions(discs, author="KALA")] == ["b" * 40]
    assert [d.id for d in filter_discussions(discs, author="серг")] == ["b" * 40]


def test_discussion_resolved_property():
    resolved_disc = _discussion("a" * 40, _note(1, resolved=True), _note(2, resolvable=False))
    assert resolved_disc.resolved is True
    open_disc = _discussion("b" * 40, _note(1, resolved=True), _note(2, resolved=False))
    assert open_disc.resolved is False
    general = _discussion("c" * 40, _note(1, resolvable=False))
    assert general.resolvable is False
    assert general.resolved is False


# ── parse_* ─────────────────────────────────────────────────────────────────────


def test_parse_discussion_and_note():
    raw = {
        "id": "e74e67b1" + "0" * 32,
        "individual_note": False,
        "notes": [
            {
                "id": 17209,
                "body": "**Контракт дат**",
                "author": {"name": "Александр Хромов", "username": "hr82al"},
                "system": False,
                "resolvable": True,
                "resolved": False,
                "type": "DiffNote",
                "position": {
                    "old_path": "src/a.js",
                    "new_path": "src/a.js",
                    "old_line": None,
                    "new_line": 64,
                },
            },
            "garbage",
        ],
    }
    disc = parse_discussion(raw)
    assert disc.id.startswith("e74e67b1")
    assert len(disc.notes) == 1
    note = disc.notes[0]
    assert note.id == 17209
    assert note.author_username == "hr82al"
    assert note.position is not None
    assert note.position.new_line == 64
    loc = disc.location()
    assert loc is not None
    assert loc.new_path == "src/a.js"


def test_parse_mr_info_diff_refs_null():
    raw = {
        "iid": 5,
        "title": "t",
        "state": "opened",
        "source_branch": "feat/x",
        "web_url": "https://x/-/merge_requests/5",
        "diff_refs": {"base_sha": None, "start_sha": None, "head_sha": None},
    }
    info = parse_mr_info(raw, "wb/sl-back")
    assert info.diff_refs is None
    assert info.project == "wb/sl-back"


def test_parse_file_diff_defaults():
    fd = parse_file_diff({"old_path": "a", "new_path": "a", "diff": None})
    assert fd.diff == ""
    assert fd.deleted_file is False
