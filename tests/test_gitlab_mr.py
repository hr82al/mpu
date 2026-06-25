"""Тесты `mpu/lib/gitlab_mr.py` — только чистые функции (без сети и без моков HTTP).

I/O-клиент `GitLabClient` тестами не покрыт — прецедент kaiten/miro/slapi. Здесь:
парсинг селектора MR и git remote, line-mapping unified-diff, сборка
position-параметров, резолв дискуссии по префиксу и фильтры тредов.
"""

from __future__ import annotations

from collections.abc import Callable
from urllib.parse import parse_qs

import httpx
import pytest

from mpu.lib import env
from mpu.lib.gitlab_mr import (
    DEFAULT_BASE_URL,
    DiffLine,
    DiffRefs,
    Discussion,
    FileDiff,
    GitLabAPIError,
    GitLabClient,
    Note,
    NotePosition,
    build_position_params,
    commentable_ranges,
    diff_stat,
    encode_project,
    file_status,
    filter_discussions,
    find_diff_line,
    format_ranges,
    match_discussion,
    note_url,
    parse_discussion,
    parse_file_diff,
    parse_mr_info,
    parse_mr_ref,
    parse_note,
    parse_unified_diff,
    project_from_remote_url,
)

# Захватываем настоящий httpx.Client ДО любой подмены — фабрика создаёт реальный
# клиент с MockTransport (по образцу tests/test_slapi.py).
_REAL_HTTPX_CLIENT = httpx.Client

Handler = Callable[[httpx.Request], httpx.Response]

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


def test_diff_stat_counts_added_removed():
    # 1 removed (-a), 1 added (+b), context (c) не считается; во втором hunk'е +y.
    diff = "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -100,1 +100,2 @@\n x\n+y\n"
    assert diff_stat(diff) == (2, 1)
    assert diff_stat("@@ -0,0 +1,3 @@\n+one\n+two\n+three\n") == (3, 0)
    assert diff_stat("") == (0, 0)


def test_file_status_letters():
    def fd(*, new: bool = False, deleted: bool = False, renamed: bool = False) -> FileDiff:
        return FileDiff(
            old_path="a",
            new_path="b",
            diff="",
            new_file=new,
            renamed_file=renamed,
            deleted_file=deleted,
        )

    assert file_status(fd(new=True)) == "A"
    assert file_status(fd(deleted=True)) == "D"
    assert file_status(fd(renamed=True)) == "R"
    assert file_status(fd()) == "M"


def test_parse_mr_info_fields():
    raw = {
        "iid": 555,
        "title": "t",
        "state": "opened",
        "source_branch": "feat/x",
        "target_branch": "dev",
        "web_url": "https://x/-/merge_requests/555",
        "author": {"name": "Артём Козырев", "username": "akozirev"},
        "description": "тело MR",
    }
    info = parse_mr_info(raw, "wb/sw-front")
    assert info.target_branch == "dev"
    assert info.author_username == "akozirev"
    assert info.author_name == "Артём Козырев"
    assert info.description == "тело MR"


def test_parse_mr_info_missing_fields_default_empty():
    info = parse_mr_info({"iid": 1, "title": "t"}, "wb/sw-front")
    assert info.target_branch == ""
    assert info.author_username == ""
    assert info.description == ""


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


# ── pure-helper edge cases (доборка пропущенных веток) ───────────────────────────


def test_parse_mr_ref_url_no_marker():
    # Хост свой, но в пути нет `/-/merge_requests/` → парс не удался.
    with pytest.raises(ValueError, match="не удалось разобрать MR-URL"):
        parse_mr_ref("https://gitlab.btlz-api.ru/wb/sl-back", BASE_URL)


def test_parse_mr_ref_url_non_digit_iid():
    with pytest.raises(ValueError, match="не удалось разобрать MR-URL"):
        parse_mr_ref("https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/abc", BASE_URL)


def test_parse_mr_ref_url_empty_project():
    with pytest.raises(ValueError, match="не удалось разобрать MR-URL"):
        parse_mr_ref("https://gitlab.btlz-api.ru/-/merge_requests/5", BASE_URL)


def test_remote_url_unparseable():
    # Ни схемы `://`, ни scp-формы `host:path` → разобрать нечего.
    with pytest.raises(ValueError, match="не удалось разобрать git remote"):
        project_from_remote_url("garbage-without-colon", HOST)


def test_remote_url_empty_project():
    # Путь после хоста пуст → нет project.
    with pytest.raises(ValueError, match="пустой project"):
        project_from_remote_url("https://gitlab.btlz-api.ru/", HOST)


def test_remote_scp_only_git_suffix_is_empty_project():
    # `git@host:.git` → path=".git" → после removesuffix пусто.
    with pytest.raises(ValueError, match="пустой project"):
        project_from_remote_url("git@gitlab.btlz-api.ru:.git", HOST)


def test_parse_discussion_notes_not_a_list():
    # `notes` не список (или отсутствует) → _dict_items вернёт [] (без падения).
    disc = parse_discussion({"id": "a" * 40, "notes": "garbage"})
    assert disc.notes == []
    disc_missing = parse_discussion({"id": "b" * 40})
    assert disc_missing.notes == []
    assert disc_missing.individual_note is False


def test_parse_note_missing_fields_and_no_position():
    # Минимальная нота: всё кроме id отсутствует → None/пусто, position=None.
    note = parse_note({"id": 7})
    assert note.id == 7
    assert note.body == ""
    assert note.author_name == ""
    assert note.author_username == ""
    assert note.created_at is None
    assert note.position is None
    assert note.system is False
    assert note.resolvable is False


def test_parse_note_author_not_dict():
    # author не объект → имя/username пустые (без падения).
    note = parse_note({"id": 8, "author": "not-a-dict", "position": "not-a-dict"})
    assert note.author_name == ""
    assert note.position is None


def test_parse_mr_info_full_with_diff_refs_and_status_fields():
    raw = {
        "iid": 1499,
        "title": "feat",
        "state": "merged",
        "source_branch": "feat/x",
        "target_branch": "dev",
        "web_url": "https://x/wb/sl-back/-/merge_requests/1499",
        "author": {"name": "Имя", "username": "user"},
        "description": "тело",
        "diff_refs": {"base_sha": "b" * 40, "start_sha": "s" * 40, "head_sha": "h" * 40},
        "project_id": 321,
        "sha": "f" * 40,
        "merge_commit_sha": "m" * 40,
        "squash_commit_sha": "q" * 40,
    }
    info = parse_mr_info(raw, "wb/sl-back")
    assert info.diff_refs is not None
    assert info.diff_refs.base_sha == "b" * 40
    assert info.diff_refs.head_sha == "h" * 40
    assert info.project_id == 321
    assert info.sha == "f" * 40
    assert info.merge_commit_sha == "m" * 40
    assert info.squash_commit_sha == "q" * 40


def test_parse_mr_info_partial_diff_refs_is_none():
    # Один из трёх SHA пуст → diff_refs целиком None (нельзя позиционировать).
    raw = {
        "iid": 5,
        "diff_refs": {"base_sha": "b" * 40, "start_sha": "", "head_sha": "h" * 40},
    }
    info = parse_mr_info(raw, "wb/sl-back")
    assert info.diff_refs is None
    assert info.project_id is None
    assert info.sha is None


# ── GitLabAPIError ──────────────────────────────────────────────────────────────


def test_gitlab_api_error_attrs_and_message():
    err = GitLabAPIError("POST", "/projects/1/merge_requests", 422, "Z" * 500)
    assert err.method == "POST"
    assert err.path == "/projects/1/merge_requests"
    assert err.status == 422
    assert err.body == "Z" * 500  # полное тело сохранено
    text = str(err)
    assert "gitlab POST /projects/1/merge_requests -> 422:" in text
    # В сообщении тело усечено до 300 символов.
    assert "Z" * 300 in text
    assert "Z" * 301 not in text


# ── GitLabClient (httpx.MockTransport) ──────────────────────────────────────────


def _patch_transport(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> None:
    """Подменить httpx.Client фабрикой, гоняющей все запросы в MockTransport."""
    transport = httpx.MockTransport(handler)

    def factory(
        *,
        base_url: str,
        headers: dict[str, str],
        timeout: httpx.Timeout,
        trust_env: bool,
    ) -> httpx.Client:
        _ = trust_env  # MockTransport не выходит в сеть — флаг не важен
        return _REAL_HTTPX_CLIENT(
            transport=transport, base_url=base_url, headers=headers, timeout=timeout
        )

    monkeypatch.setattr(httpx, "Client", factory)


def _client(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> GitLabClient:
    _patch_transport(monkeypatch, handler)
    return GitLabClient("TESTTOKEN", DEFAULT_BASE_URL)


def test_client_host_and_base_url_strip_slash():
    client = GitLabClient("tok", "https://gitlab.btlz-api.ru/")
    assert client.base_url == "https://gitlab.btlz-api.ru"
    assert client.host == "gitlab.btlz-api.ru"


# ── from_env ────────────────────────────────────────────────────────────────────


def test_from_env_builds_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.setenv("GLAB_TOKEN", "TOK")
    monkeypatch.setenv("GITLAB_BASE_URL", "https://gl.example.com/")
    client = GitLabClient.from_env()
    assert client.base_url == "https://gl.example.com"
    assert client.host == "gl.example.com"


def test_from_env_default_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.setenv("GLAB_TOKEN", "TOK")
    monkeypatch.delenv("GITLAB_BASE_URL", raising=False)
    assert GitLabClient.from_env().base_url == DEFAULT_BASE_URL


def test_from_env_missing_token_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("GLAB_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        GitLabClient.from_env()


# ── _request: успех / ошибка / транспорт / пустой ответ ──────────────────────────


def test_get_mr_sends_token_and_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["token"] = request.headers.get("private-token")
        captured["accept"] = request.headers.get("accept")
        return httpx.Response(200, json={"iid": 5, "title": "T", "state": "opened"})

    info = _client(monkeypatch, handler).get_mr("wb/sl-back", 5)
    assert info.iid == 5
    assert info.title == "T"
    assert captured["method"] == "GET"
    # encode_project + _mr_path: `wb/sl-back` уходит URL-encoded, путь декодируется.
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5"
    assert captured["token"] == "TESTTOKEN"
    assert captured["accept"] == "application/json"


def test_request_non_2xx_raises_gitlab_api_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(403, text="forbidden")

    with pytest.raises(GitLabAPIError) as ei:
        _client(monkeypatch, handler).get_mr("wb/sl-back", 5)
    assert ei.value.status == 403
    assert ei.value.body == "forbidden"
    assert ei.value.method == "GET"


def test_request_transport_error_status_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns fail", request=request)

    with pytest.raises(GitLabAPIError) as ei:
        _client(monkeypatch, handler).get_mr("wb/sl-back", 5)
    assert ei.value.status == 0
    assert "dns fail" in ei.value.body


def test_delete_note_empty_response_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        return httpx.Response(204, text="")

    assert _client(monkeypatch, handler).delete_note("wb/sl-back", 5, 99) is None
    assert captured["method"] == "DELETE"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5/notes/99"


# ── пагинация ────────────────────────────────────────────────────────────────────


def test_find_open_mrs_paginates(monkeypatch: pytest.MonkeyPatch) -> None:
    pages: list[int] = []
    branches: list[str | None] = []
    states: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        pages.append(page)
        branches.append(request.url.params.get("source_branch"))
        states.append(request.url.params.get("state"))
        if page == 1:
            body = [{"iid": i, "title": "t"} for i in range(100)]
        else:
            body = [{"iid": 100, "title": "last"}]
        return httpx.Response(200, json=body)

    mrs = _client(monkeypatch, handler).find_open_mrs("wb/sl-back", "feat/x")
    assert len(mrs) == 101
    assert pages == [1, 2]  # вторая страница неполная → стоп
    assert branches == ["feat/x", "feat/x"]
    assert states == ["opened", "opened"]


def test_list_discussions_single_page(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        return httpx.Response(200, json=[{"id": "a" * 40, "notes": []}])

    discs = _client(monkeypatch, handler).list_discussions("wb/sl-back", 5)
    assert len(discs) == 1
    assert discs[0].id == "a" * 40
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5/discussions"


def test_list_my_merge_requests_global_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["scope"] = request.url.params.get("scope")
        captured["updated_after"] = request.url.params.get("updated_after")
        captured["order_by"] = request.url.params.get("order_by")
        return httpx.Response(
            200,
            json=[{"iid": 7, "title": "t", "web_url": "https://x/wb/sl-back/-/merge_requests/7"}],
        )

    mrs = _client(monkeypatch, handler).list_my_merge_requests("2026-06-18T00:00:00Z")
    assert mrs[0].iid == 7
    assert mrs[0].project == ""  # глобальный эндпоинт без пути проекта
    assert captured["path"] == "/api/v4/merge_requests"
    assert captured["scope"] == "created_by_me"
    assert captured["updated_after"] == "2026-06-18T00:00:00Z"
    assert captured["order_by"] == "created_at"


# ── commit_branch_names: успех / 404 / прочая ошибка ─────────────────────────────


def test_commit_branch_names_success_filters_nameless(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["type"] = request.url.params.get("type")
        return httpx.Response(200, json=[{"name": "main"}, {"name": "dev"}, {"foo": "bar"}])

    names = _client(monkeypatch, handler).commit_branch_names(42, "abc123")
    assert names == ["main", "dev"]
    assert captured["path"] == "/api/v4/projects/42/repository/commits/abc123/refs"
    assert captured["type"] == "branch"


def test_commit_branch_names_404_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(404, text="not found")

    assert _client(monkeypatch, handler).commit_branch_names(42, "deadbeef") == []


def test_commit_branch_names_other_error_reraises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(500, text="boom")

    with pytest.raises(GitLabAPIError) as ei:
        _client(monkeypatch, handler).commit_branch_names(42, "deadbeef")
    assert ei.value.status == 500


# ── list_diffs: dict-ответ vs не-dict ───────────────────────────────────────────


def test_list_diffs_parses_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["raw"] = request.url.params.get("access_raw_diffs")
        return httpx.Response(
            200,
            json={
                "changes": [
                    {"old_path": "a", "new_path": "b", "diff": "@@ -1 +1 @@\n-x\n+y\n"},
                ]
            },
        )

    diffs = _client(monkeypatch, handler).list_diffs("wb/sl-back", 5)
    assert len(diffs) == 1
    assert diffs[0].new_path == "b"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5/changes"
    assert captured["raw"] == "true"


def test_list_diffs_non_dict_payload_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _ = request
        return httpx.Response(200, json=[1, 2, 3])

    assert _client(monkeypatch, handler).list_diffs("wb/sl-back", 5) == []


# ── мутации: form-encoded data (position[...] и тела) ────────────────────────────


def test_create_discussion_general(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(201, json={"id": "d" * 40, "notes": []})

    disc = _client(monkeypatch, handler).create_discussion("wb/sl-back", 5, "hello")
    assert disc.id == "d" * 40
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5/discussions"
    assert captured["form"] == {"body": ["hello"]}


def test_create_discussion_with_position(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(201, json={"id": "e" * 40, "notes": []})

    position = {"position[new_line]": "5", "position[new_path]": "src/a.ts"}
    _client(monkeypatch, handler).create_discussion("wb/sl-back", 5, "body", position=position)
    assert captured["form"] == {
        "body": ["body"],
        "position[new_line]": ["5"],
        "position[new_path]": ["src/a.ts"],
    }


def test_reply_posts_note(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(
            201,
            json={"id": 123, "body": "ok", "author": {"name": "A", "username": "a"}},
        )

    note = _client(monkeypatch, handler).reply("wb/sl-back", 5, "d" * 40, "my reply")
    assert note.id == 123
    assert note.author_username == "a"
    assert captured["path"] == (
        "/api/v4/projects/wb/sl-back/merge_requests/5/discussions/" + "d" * 40 + "/notes"
    )
    assert captured["form"] == {"body": ["my reply"]}


def test_update_note_puts_body(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(200, json={"id": 77, "body": "edited"})

    note = _client(monkeypatch, handler).update_note("wb/sl-back", 5, 77, "edited")
    assert note.body == "edited"
    assert captured["method"] == "PUT"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5/notes/77"
    assert captured["form"] == {"body": ["edited"]}


def test_set_resolved_true_and_false(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["resolved"] = request.url.params.get("resolved")
        return httpx.Response(200, text="")

    client = _client(monkeypatch, handler)
    assert client.set_resolved("wb/sl-back", 5, "d" * 40, True) is None
    assert captured["method"] == "PUT"
    assert captured["resolved"] == "true"
    client.set_resolved("wb/sl-back", 5, "d" * 40, False)
    assert captured["resolved"] == "false"


def test_set_description_replaces_and_returns_mr(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(200, json={"iid": 5, "description": "new desc"})

    info = _client(monkeypatch, handler).set_description("wb/sl-back", 5, "new desc")
    assert info.description == "new desc"
    assert captured["method"] == "PUT"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests/5"
    assert captured["form"] == {"description": ["new desc"]}


def test_create_mr_with_description(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(
            201,
            json={"iid": 9, "source_branch": "feat/x", "target_branch": "dev", "title": "T"},
        )

    info = _client(monkeypatch, handler).create_mr("wb/sl-back", "feat/x", "dev", "T", "body text")
    assert info.iid == 9
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/v4/projects/wb/sl-back/merge_requests"
    assert captured["form"] == {
        "source_branch": ["feat/x"],
        "target_branch": ["dev"],
        "title": ["T"],
        "description": ["body text"],
    }


def test_create_mr_without_description_omits_field(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(201, json={"iid": 10, "title": "T"})

    info = _client(monkeypatch, handler).create_mr("wb/sl-back", "feat/x", "dev", "T")
    assert info.iid == 10
    assert captured["form"] == {
        "source_branch": ["feat/x"],
        "target_branch": ["dev"],
        "title": ["T"],
    }
