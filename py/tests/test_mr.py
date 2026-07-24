"""Тесты `mpu mr`.

Две части. Чистые функции (без сети/git/моков): разбор FILE:LINE, выбор источника
тела, метка позиции, excerpt и текст ошибки «строка вне диффа». CLI-подкоманды:
прогон typer-app через CliRunner с фейковым GitLabClient (подмена
`GitLabClient.from_env`) и фейковым git (`subprocess.run`) — без реальной сети.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from mpu.commands import mr
from mpu.commands.mr import (
    excerpt,
    line_not_in_diff_message,
    parse_location,
    position_label,
    resolve_body,
)
from mpu.lib.gitlab_mr import (
    DiffRefs,
    Discussion,
    FileDiff,
    GitLabAPIError,
    GitLabClient,
    MrInfo,
    Note,
    NotePosition,
)


def _no_stdin() -> str:
    raise AssertionError("stdin не должен читаться")


# ── parse_location ──────────────────────────────────────────────────────────────


def test_parse_location_ok():
    assert parse_location("src/a.js:64") == ("src/a.js", 64)


def test_parse_location_path_with_colon():
    assert parse_location("C:src/a.js:5") == ("C:src/a.js", 5)


@pytest.mark.parametrize("bad", ["src/a.js", ":5", "src/a.js:", "src/a.js:0", "src/a.js:x"])
def test_parse_location_bad(bad: str):
    with pytest.raises(typer.BadParameter):
        parse_location(bad)


# ── resolve_body ────────────────────────────────────────────────────────────────


def test_resolve_body_message():
    assert resolve_body("текст", None, stdin_read=_no_stdin) == "текст"


def test_resolve_body_file(tmp_path: Path):
    body_file = tmp_path / "body.md"
    body_file.write_text("**из файла**", encoding="utf-8")
    assert resolve_body(None, str(body_file), stdin_read=_no_stdin) == "**из файла**"


def test_resolve_body_stdin():
    assert resolve_body(None, "-", stdin_read=lambda: "из stdin") == "из stdin"


def test_resolve_body_exactly_one_source():
    with pytest.raises(typer.BadParameter, match="ровно одно"):
        resolve_body(None, None, stdin_read=_no_stdin)
    with pytest.raises(typer.BadParameter, match="ровно одно"):
        resolve_body("a", "-", stdin_read=_no_stdin)


def test_resolve_body_empty_and_missing_file(tmp_path: Path):
    with pytest.raises(typer.BadParameter, match="пустое"):
        resolve_body("   \n", None, stdin_read=_no_stdin)
    with pytest.raises(typer.BadParameter, match="не удалось прочитать"):
        resolve_body(None, str(tmp_path / "nope.md"), stdin_read=_no_stdin)


# ── position_label / excerpt ────────────────────────────────────────────────────


def test_position_label_variants():
    assert position_label(None) == ""
    new_side = NotePosition(old_path="a", new_path="src/a.js", old_line=None, new_line=64)
    assert position_label(new_side) == "src/a.js:64"
    old_side = NotePosition(old_path="src/a.js", new_path=None, old_line=60, new_line=None)
    assert position_label(old_side) == "src/a.js:60 (old)"
    path_only = NotePosition(old_path=None, new_path="src/a.js", old_line=None, new_line=None)
    assert position_label(path_only) == "src/a.js"


def test_excerpt():
    assert excerpt("первая строка\nвторая") == "первая строка"
    assert excerpt("  \n\nтело") == "тело"
    assert excerpt("") == ""
    long = "x" * 100
    assert excerpt(long, width=10) == "x" * 9 + "…"


# ── line_not_in_diff_message ────────────────────────────────────────────────────


def _file_diff(diff: str, *, deleted: bool = False) -> FileDiff:
    return FileDiff(
        old_path="src/a.js",
        new_path="src/a.js",
        diff=diff,
        new_file=False,
        renamed_file=False,
        deleted_file=deleted,
    )


def test_line_not_in_diff_lists_ranges():
    fd = _file_diff("@@ -10,2 +10,3 @@\n ctx\n+a\n+b\n")
    message = line_not_in_diff_message(fd, "src/a.js", 500, "new")
    assert "src/a.js:500" in message
    assert "10-12" in message
    assert "--old" in message


def test_line_not_in_diff_deleted_file_hints_old():
    fd = _file_diff("@@ -1,2 +0,0 @@\n-a\n-b\n", deleted=True)
    message = line_not_in_diff_message(fd, "src/a.js", 1, "new")
    assert "удалён" in message
    assert "--old" in message


def test_line_not_in_diff_empty_side():
    fd = _file_diff("@@ -0,0 +1,2 @@\n+a\n+b\n")
    message = line_not_in_diff_message(fd, "src/a.js", 5, "old")
    assert "нет комментируемых строк" in message


# ── CLI-подкоманды: фейковый GitLabClient + git, прогон через CliRunner ──────────
# Покрывают I/O-команды (view/create/describe/files/diff/comment/note/comments/show/
# reply/edit/delete/resolve/unresolve) и их приватные I/O-хелперы (_client, _git,
# _resolve_target, _file_rows, _diff_file_header, …) через публичный typer-app —
# без сети: GitLabClient.from_env и subprocess.run подменяются фейками.

runner = CliRunner()

BASE_URL = "https://gitlab.btlz-api.ru"
HOST = "gitlab.btlz-api.ru"
MR_REF = "wb/sl-back!1499"
DEFAULT_REFS = DiffRefs(base_sha="b" * 40, start_sha="s" * 40, head_sha="h" * 40)


def _mk_mr(
    *,
    project: str = "wb/sl-back",
    iid: int = 1499,
    title: str = "feat: x",
    state: str = "opened",
    source_branch: str = "feat/x",
    target_branch: str = "dev",
    description: str = "тело MR",
    diff_refs: DiffRefs | None = DEFAULT_REFS,
    web_url: str = "https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1499",
) -> MrInfo:
    return MrInfo(
        project=project,
        iid=iid,
        title=title,
        state=state,
        source_branch=source_branch,
        target_branch=target_branch,
        web_url=web_url,
        author_name="Имя Фамилия",
        author_username="user",
        description=description,
        diff_refs=diff_refs,
    )


def _mk_fd(
    *,
    old_path: str = "src/a.js",
    new_path: str = "src/a.js",
    diff: str = "@@ -10,2 +10,3 @@\n ctx\n+a\n+b\n",
    new_file: bool = False,
    renamed_file: bool = False,
    deleted_file: bool = False,
) -> FileDiff:
    return FileDiff(
        old_path=old_path,
        new_path=new_path,
        diff=diff,
        new_file=new_file,
        renamed_file=renamed_file,
        deleted_file=deleted_file,
    )


def _mk_note(
    note_id: int = 1,
    *,
    body: str = "тело ноты",
    system: bool = False,
    resolvable: bool = True,
    resolved: bool = False,
    author_username: str = "reviewer",
    author_name: str = "Ревьюер",
    created_at: str | None = "2026-06-20T10:00:00Z",
    position: NotePosition | None = None,
) -> Note:
    return Note(
        id=note_id,
        body=body,
        author_name=author_name,
        author_username=author_username,
        created_at=created_at,
        updated_at=None,
        system=system,
        resolvable=resolvable,
        resolved=resolved,
        type="DiffNote" if position is not None else None,
        position=position,
    )


def _mk_disc(disc_id: str, *notes: Note) -> Discussion:
    return Discussion(id=disc_id, individual_note=False, notes=list(notes))


class FakeClient:
    """Фейк `GitLabClient`: отдаёт заранее заданные ответы, пишет вызовы в `calls`;
    если по имени метода в `errors` лежит исключение — бросает его (error-пути команд)."""

    def __init__(
        self,
        *,
        mr: MrInfo | None = None,
        diffs: list[FileDiff] | None = None,
        discussions: list[Discussion] | None = None,
        open_mrs: list[MrInfo] | None = None,
        created_discussion: Discussion | None = None,
        created_note: Note | None = None,
        created_mr: MrInfo | None = None,
        updated_mr: MrInfo | None = None,
    ) -> None:
        self.base_url = BASE_URL
        self.host = HOST
        self._mr = mr
        self._diffs = diffs if diffs is not None else []
        self._discussions = discussions if discussions is not None else []
        self._open_mrs = open_mrs if open_mrs is not None else []
        self._created_discussion = created_discussion
        self._created_note = created_note
        self._created_mr = created_mr
        self._updated_mr = updated_mr
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.errors: dict[str, Exception] = {}

    def _record(self, name: str, *args: object) -> None:
        self.calls.append((name, args))
        err = self.errors.get(name)
        if err is not None:
            raise err

    def get_mr(self, project: str, iid: int) -> MrInfo:
        self._record("get_mr", project, iid)
        assert self._mr is not None
        return self._mr

    def find_open_mrs(self, project: str, branch: str) -> list[MrInfo]:
        self._record("find_open_mrs", project, branch)
        return self._open_mrs

    def list_diffs(self, project: str, iid: int) -> list[FileDiff]:
        self._record("list_diffs", project, iid)
        return self._diffs

    def list_discussions(self, project: str, iid: int) -> list[Discussion]:
        self._record("list_discussions", project, iid)
        return self._discussions

    def create_discussion(
        self, project: str, iid: int, body: str, position: dict[str, str] | None = None
    ) -> Discussion:
        self._record("create_discussion", project, iid, body, position)
        assert self._created_discussion is not None
        return self._created_discussion

    def reply(self, project: str, iid: int, discussion_id: str, body: str) -> Note:
        self._record("reply", project, iid, discussion_id, body)
        assert self._created_note is not None
        return self._created_note

    def update_note(self, project: str, iid: int, note_id: int, body: str) -> Note:
        self._record("update_note", project, iid, note_id, body)
        assert self._created_note is not None
        return self._created_note

    def delete_note(self, project: str, iid: int, note_id: int) -> None:
        self._record("delete_note", project, iid, note_id)

    def set_resolved(self, project: str, iid: int, discussion_id: str, resolved: bool) -> None:
        self._record("set_resolved", project, iid, discussion_id, resolved)

    def set_description(self, project: str, iid: int, description: str) -> MrInfo:
        self._record("set_description", project, iid, description)
        assert self._updated_mr is not None
        return self._updated_mr

    def create_mr(
        self,
        project: str,
        source_branch: str,
        target_branch: str,
        title: str,
        description: str | None = None,
    ) -> MrInfo:
        self._record("create_mr", project, source_branch, target_branch, title, description)
        assert self._created_mr is not None
        return self._created_mr


def _install_client(monkeypatch: pytest.MonkeyPatch, fake: FakeClient) -> None:
    monkeypatch.setattr(GitLabClient, "from_env", lambda: fake)


def _install_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise() -> GitLabClient:
        raise RuntimeError("environment variable GLAB_TOKEN is not set")

    monkeypatch.setattr(GitLabClient, "from_env", _raise)


def _install_git(
    monkeypatch: pytest.MonkeyPatch,
    *,
    remote: str = "git@gitlab.btlz-api.ru:wb/sl-back.git",
    branch: str = "feat/x",
    error: Exception | None = None,
) -> None:
    def fake_run(
        args: list[str],
        *,
        capture_output: bool = False,
        text: bool = False,
        check: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        _ = (capture_output, text, check)
        if error is not None:
            raise error
        sub = args[1] if len(args) > 1 else ""
        if sub == "remote":
            out = remote
        elif sub == "rev-parse":
            out = branch
        else:
            out = ""
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=out + "\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)


class _FakeStdin:
    def __init__(self, *, tty: bool) -> None:
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


class _FakeSys:
    def __init__(self, *, tty: bool) -> None:
        self.stdin = _FakeStdin(tty=tty)


# ── view ─────────────────────────────────────────────────────────────────────


def test_view_default_output(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr()))
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "MR wb/sl-back!1499 — feat: x [opened]" in res.stdout
    assert "author: Имя Фамилия (@user)" in res.stdout
    assert "branch: feat/x → dev" in res.stdout
    assert "тело MR" in res.stdout


def test_view_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr()))
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF, "--json"])
    assert res.exit_code == 0
    obj = json.loads(res.stdout)
    assert obj["iid"] == 1499
    assert obj["author_username"] == "user"
    assert obj["diff_refs"]["base_sha"] == "b" * 40


def test_view_no_description_omits_body(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(description="")))
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "url:" in res.stdout
    assert res.stdout.rstrip().endswith("/merge_requests/1499")


def test_view_404_error_hints_mr(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["get_mr"] = GitLabAPIError("GET", "/x", 404, "not found")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "проверь --mr" in res.stderr


def test_view_401_error_hints_token(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["get_mr"] = GitLabAPIError("GET", "/x", 401, "unauthorized")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" in res.stderr


def test_view_foreign_url_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr()))
    res = runner.invoke(mr.app, ["view", "--mr", "https://gitlab.com/x/y/-/merge_requests/1"])
    assert res.exit_code == 1
    assert "хост" in res.stderr


def test_view_missing_token_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_missing_token(monkeypatch)
    res = runner.invoke(mr.app, ["view", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "GLAB_TOKEN" in res.stderr


# ── _resolve_target / _git: адресация MR ─────────────────────────────────────


def test_view_bare_iid_uses_git_remote(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr())
    _install_client(monkeypatch, fake)
    _install_git(monkeypatch)
    res = runner.invoke(mr.app, ["view", "--mr", "1499"])
    assert res.exit_code == 0
    assert ("get_mr", ("wb/sl-back", 1499)) in fake.calls


def test_view_autodetect_single_open_mr(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr(iid=42), open_mrs=[_mk_mr(iid=42)])
    _install_client(monkeypatch, fake)
    _install_git(monkeypatch, branch="feat/x")
    res = runner.invoke(mr.app, ["view"])
    assert res.exit_code == 0
    assert ("find_open_mrs", ("wb/sl-back", "feat/x")) in fake.calls
    assert ("get_mr", ("wb/sl-back", 42)) in fake.calls


def test_view_autodetect_no_open_mr(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(open_mrs=[]))
    _install_git(monkeypatch)
    res = runner.invoke(mr.app, ["view"])
    assert res.exit_code == 1
    assert "нет открытого MR" in res.stderr


def test_view_autodetect_multiple_open_mrs(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(
        monkeypatch,
        FakeClient(open_mrs=[_mk_mr(iid=1, title="a"), _mk_mr(iid=2, title="b")]),
    )
    _install_git(monkeypatch)
    res = runner.invoke(mr.app, ["view"])
    assert res.exit_code == 1
    assert "несколько открытых MR" in res.stderr


def test_view_autodetect_detached_head(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient())
    _install_git(monkeypatch, branch="HEAD")
    res = runner.invoke(mr.app, ["view"])
    assert res.exit_code == 1
    assert "detached HEAD" in res.stderr


def test_view_git_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient())
    _install_git(monkeypatch, error=FileNotFoundError())
    res = runner.invoke(mr.app, ["view", "--mr", "1499"])
    assert res.exit_code == 1
    assert "git не найден" in res.stderr


def test_view_git_command_error(monkeypatch: pytest.MonkeyPatch) -> None:
    err = subprocess.CalledProcessError(
        128, ["git", "remote", "get-url", "origin"], stderr="fatal: not a git repository"
    )
    _install_client(monkeypatch, FakeClient())
    _install_git(monkeypatch, error=err)
    res = runner.invoke(mr.app, ["view", "--mr", "1499"])
    assert res.exit_code == 1
    assert "fatal: not a git repository" in res.stderr


# ── create ───────────────────────────────────────────────────────────────────


def test_create_with_project_source_and_description(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(created_mr=_mk_mr(iid=9))
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        mr.app,
        [
            "create",
            "--project",
            "wb/sl-back",
            "--source",
            "feat/x",
            "--target",
            "dev",
            "--title",
            "feat: x",
            "-m",
            "desc body",
        ],
    )
    assert res.exit_code == 0
    assert "создан MR wb/sl-back!9" in res.stdout
    assert ("create_mr", ("wb/sl-back", "feat/x", "dev", "feat: x", "desc body")) in fake.calls


def test_create_autodetect_git(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(created_mr=_mk_mr(iid=9))
    _install_client(monkeypatch, fake)
    _install_git(monkeypatch)
    res = runner.invoke(mr.app, ["create", "--target", "dev", "--title", "feat"])
    assert res.exit_code == 0
    assert "branch: feat/x → dev" in res.stdout
    assert ("create_mr", ("wb/sl-back", "feat/x", "dev", "feat", "")) in fake.calls


def test_create_no_description_passes_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(created_mr=_mk_mr(iid=10))
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        mr.app,
        [
            "create",
            "--project",
            "wb/sl-back",
            "--source",
            "feat/x",
            "--target",
            "dev",
            "--title",
            "T",
        ],
    )
    assert res.exit_code == 0
    assert ("create_mr", ("wb/sl-back", "feat/x", "dev", "T", "")) in fake.calls


def test_create_detached_head_needs_source(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient())
    _install_git(monkeypatch, branch="HEAD")
    res = runner.invoke(
        mr.app, ["create", "--project", "wb/sl-back", "--target", "dev", "--title", "T"]
    )
    assert res.exit_code == 1
    assert "detached HEAD" in res.stderr


def test_create_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["create_mr"] = GitLabAPIError("POST", "/x", 409, "conflict")
    _install_client(monkeypatch, fake)
    res = runner.invoke(
        mr.app,
        [
            "create",
            "--project",
            "wb/sl-back",
            "--source",
            "feat/x",
            "--target",
            "dev",
            "--title",
            "T",
        ],
    )
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


# ── describe ─────────────────────────────────────────────────────────────────


def test_describe_replaces(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(updated_mr=_mk_mr())
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["describe", "--mr", MR_REF, "-m", "новое описание"])
    assert res.exit_code == 0
    assert "описание MR wb/sl-back!1499 обновлено" in res.stdout
    assert ("set_description", ("wb/sl-back", 1499, "новое описание")) in fake.calls


def test_describe_requires_body(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(updated_mr=_mk_mr()))
    res = runner.invoke(mr.app, ["describe", "--mr", MR_REF])
    assert res.exit_code == 2


def test_describe_stdin_body(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(updated_mr=_mk_mr())
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["describe", "--mr", MR_REF, "-F", "-"], input="из stdin\n")
    assert res.exit_code == 0
    assert ("set_description", ("wb/sl-back", 1499, "из stdin\n")) in fake.calls


# ── files ────────────────────────────────────────────────────────────────────

_FILES_DIFFS = [
    _mk_fd(diff="@@ -1,1 +1,2 @@\n a\n+b\n"),
    _mk_fd(
        old_path="src/new.js",
        new_path="src/new.js",
        new_file=True,
        diff="@@ -0,0 +1,2 @@\n+x\n+y\n",
    ),
    _mk_fd(
        old_path="src/old.js",
        new_path="src/renamed.js",
        renamed_file=True,
        diff="@@ -1,1 +1,1 @@\n-p\n+q\n",
    ),
    _mk_fd(
        old_path="src/del.js",
        new_path="",
        deleted_file=True,
        diff="@@ -1,1 +0,0 @@\n-z\n",
    ),
]


def test_files_table(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_FILES_DIFFS)))
    res = runner.invoke(mr.app, ["files", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "(4 files, +4 / -2)" in res.stdout


def test_files_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_FILES_DIFFS)))
    res = runner.invoke(mr.app, ["files", "--mr", MR_REF, "--json"])
    assert res.exit_code == 0
    rows = json.loads(res.stdout)
    assert [r["status"] for r in rows] == ["M", "A", "R", "D"]
    assert [r["additions"] for r in rows] == [1, 2, 1, 0]
    assert [r["deletions"] for r in rows] == [0, 0, 1, 1]


def test_files_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["list_diffs"] = GitLabAPIError("GET", "/x", 500, "boom")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["files", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


# ── diff ─────────────────────────────────────────────────────────────────────

_DIFF_DIFFS = [
    _mk_fd(diff="@@ -1,1 +1,2 @@\n a\n+b\n"),
    _mk_fd(
        old_path="src/new.js",
        new_path="src/new.js",
        new_file=True,
        diff="@@ -0,0 +1,1 @@\n+x\n",
    ),
    _mk_fd(
        old_path="src/gone.js",
        new_path="src/gone.js",
        deleted_file=True,
        diff="@@ -1,1 +0,0 @@\n-z\n",
    ),
    _mk_fd(
        old_path="src/old.js",
        new_path="src/renamed.js",
        renamed_file=True,
        diff="@@ -1,1 +1,1 @@\n-p\n+q\n",
    ),
    _mk_fd(old_path="src/bin.png", new_path="src/bin.png", diff=""),
]


def test_diff_text_with_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_DIFF_DIFFS)))
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "diff --git a/src/a.js b/src/a.js" in res.stdout
    assert "[new file]" in res.stdout
    assert "[deleted file]" in res.stdout
    assert "[renamed]" in res.stdout
    assert "(binary / без текстового диффа)" in res.stdout


def test_diff_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_DIFF_DIFFS)))
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF, "--json"])
    assert res.exit_code == 0
    rows = json.loads(res.stdout)
    assert len(rows) == 5
    assert rows[1]["new_path"] == "src/new.js"


def test_diff_file_filter_match(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_DIFF_DIFFS)))
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF, "--file", "renamed"])
    assert res.exit_code == 0
    assert "src/renamed.js" in res.stdout
    assert "src/a.js" not in res.stdout


def test_diff_file_filter_no_match(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=list(_DIFF_DIFFS)))
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF, "--file", "zzz"])
    assert res.exit_code == 1
    assert "нет изменённых файлов по подстроке" in res.stderr


def test_diff_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(diffs=[]))
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "(MR без изменённых файлов)" in res.stdout


# ── comment ──────────────────────────────────────────────────────────────────


def test_comment_added_line_success(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(
        mr=_mk_mr(),
        diffs=[_mk_fd()],
        created_discussion=_mk_disc("c" * 40, _mk_note(8888)),
    )
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["comment", "src/a.js:11", "--mr", MR_REF, "-m", "ревью"])
    assert res.exit_code == 0
    assert "создано: discussion cccccccc на src/a.js:11" in res.stdout
    assert "#note_8888" in res.stdout
    name, args = fake.calls[-1]
    assert name == "create_discussion"
    position = args[3]
    assert isinstance(position, dict)
    assert position["position[new_line]"] == "11"


def test_comment_old_removed_line(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(
        mr=_mk_mr(),
        diffs=[_mk_fd(diff="@@ -10,2 +10,1 @@\n-old10\n ctx11\n")],
        created_discussion=_mk_disc("d" * 40, _mk_note(1)),
    )
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["comment", "src/a.js:10", "--mr", MR_REF, "--old", "-m", "x"])
    assert res.exit_code == 0
    name, args = fake.calls[-1]
    assert name == "create_discussion"
    position = args[3]
    assert isinstance(position, dict)
    assert position["position[old_line]"] == "10"


def test_comment_line_not_in_diff(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), diffs=[_mk_fd()]))
    res = runner.invoke(mr.app, ["comment", "src/a.js:500", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "не входит в diff" in res.stderr


def test_comment_file_not_in_diff(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), diffs=[_mk_fd()]))
    res = runner.invoke(mr.app, ["comment", "src/missing.js:11", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "не изменён" in res.stderr


def test_comment_no_diff_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(diff_refs=None), diffs=[_mk_fd()]))
    res = runner.invoke(mr.app, ["comment", "src/a.js:11", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "нет diff" in res.stderr


def test_comment_bad_location(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), diffs=[_mk_fd()]))
    res = runner.invoke(mr.app, ["comment", "src/a.js", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 2


# ── note ─────────────────────────────────────────────────────────────────────


def test_note_general_with_url(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr(), created_discussion=_mk_disc("a" * 40, _mk_note(700)))
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["note", "--mr", MR_REF, "-m", "общий коммент"])
    assert res.exit_code == 0
    assert "создано: discussion aaaaaaaa" in res.stdout
    assert "#note_700" in res.stdout
    name, args = fake.calls[-1]
    assert name == "create_discussion"
    assert args[3] is None


def test_note_empty_discussion_no_url(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr(), created_discussion=_mk_disc("b" * 40))
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["note", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 0
    assert "создано: discussion bbbbbbbb" in res.stdout
    assert "#note_" not in res.stdout


# ── comments / show ──────────────────────────────────────────────────────────

_POS = NotePosition(old_path="src/a.js", new_path="src/a.js", old_line=None, new_line=11)
_DISC_OPEN = _mk_disc("abc12345" + "0" * 32, _mk_note(1, position=_POS, author_username="reviewer"))
_DISC_GENERAL = _mk_disc(
    "def67890" + "0" * 32,
    _mk_note(2, resolvable=False, author_username="author", author_name="Автор"),
)
_DISC_RESOLVED = _mk_disc(
    "aaa99999" + "0" * 32,
    _mk_note(3, position=_POS, resolved=True, author_username="reviewer"),
)


def test_comments_table(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(
        monkeypatch,
        FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN, _DISC_GENERAL, _DISC_RESOLVED]),
    )
    res = runner.invoke(mr.app, ["comments", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "MR wb/sl-back!1499" in res.stdout
    assert "(3 discussions, 1 unresolved)" in res.stdout


def test_comments_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN, _DISC_GENERAL]))
    res = runner.invoke(mr.app, ["comments", "--mr", MR_REF, "--json"])
    assert res.exit_code == 0
    payload = json.loads(res.stdout)
    assert len(payload) == 2
    assert payload[0]["location"] == "src/a.js:11"
    assert payload[1]["location"] is None


def test_comments_md(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN, _DISC_RESOLVED]))
    res = runner.invoke(mr.app, ["comments", "--mr", MR_REF, "--md"])
    assert res.exit_code == 0
    assert "# MR wb/sl-back!1499 — feat: x [opened]" in res.stdout
    assert "## abc12345 · src/a.js:11 · open" in res.stdout
    assert "## aaa99999 · src/a.js:11 · resolved" in res.stdout
    assert "@reviewer" in res.stdout


def test_comments_unresolved_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(
        monkeypatch,
        FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN, _DISC_GENERAL, _DISC_RESOLVED]),
    )
    res = runner.invoke(mr.app, ["comments", "--mr", MR_REF, "--unresolved"])
    assert res.exit_code == 0
    assert "(1 discussions, 1 unresolved)" in res.stdout


def test_comments_author_and_file_filter(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN, _DISC_GENERAL]))
    res_author = runner.invoke(mr.app, ["comments", "--mr", MR_REF, "--author", "author", "--json"])
    assert res_author.exit_code == 0
    assert {d["notes"][0]["author_username"] for d in json.loads(res_author.stdout)} == {"author"}
    res_file = runner.invoke(mr.app, ["comments", "--mr", MR_REF, "--file", "a.js", "--json"])
    assert res_file.exit_code == 0
    assert [d["location"] for d in json.loads(res_file.stdout)] == ["src/a.js:11"]


def test_show_text(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(discussions=[_DISC_OPEN, _DISC_GENERAL]))
    res = runner.invoke(mr.app, ["show", "abc12345", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "src/a.js:11 · open" in res.stdout
    assert "@reviewer" in res.stdout
    assert "тело ноты" in res.stdout


def test_show_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(discussions=[_DISC_OPEN, _DISC_GENERAL]))
    res = runner.invoke(mr.app, ["show", "abc12345", "--mr", MR_REF, "--json"])
    assert res.exit_code == 0
    obj = json.loads(res.stdout)
    assert obj["id"].startswith("abc12345")
    assert obj["location"] == "src/a.js:11"


def test_show_general_location(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(discussions=[_DISC_OPEN, _DISC_GENERAL]))
    res = runner.invoke(mr.app, ["show", "def67890", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "general · note" in res.stdout


def test_show_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(discussions=[_DISC_OPEN]))
    res = runner.invoke(mr.app, ["show", "ffffff", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "не найден" in res.stderr


# ── reply / edit ─────────────────────────────────────────────────────────────


def test_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(
        mr=_mk_mr(),
        discussions=[_DISC_OPEN],
        created_note=_mk_note(555, body="ответ"),
    )
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["reply", "abc12345", "--mr", MR_REF, "-m", "поправил"])
    assert res.exit_code == 0
    assert "reply: note 555 в discussion abc12345" in res.stdout
    assert "#note_555" in res.stdout
    assert ("reply", ("wb/sl-back", 1499, _DISC_OPEN.id, "поправил")) in fake.calls


def test_edit(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(created_note=_mk_note(17, body="edited"))
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["edit", "17", "--mr", MR_REF, "-m", "новый текст"])
    assert res.exit_code == 0
    assert "note 17 обновлена" in res.stdout
    assert ("update_note", ("wb/sl-back", 1499, 17, "новый текст")) in fake.calls


# ── delete ───────────────────────────────────────────────────────────────────


def test_delete_yes(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["delete", "99", "--mr", MR_REF, "--yes"])
    assert res.exit_code == 0
    assert "note 99 удалена" in res.stdout
    assert ("delete_note", ("wb/sl-back", 1499, 99)) in fake.calls


def test_delete_no_tty_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient())
    res = runner.invoke(mr.app, ["delete", "99", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "нет TTY" in res.stderr


def test_delete_confirm_accept(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    _install_client(monkeypatch, fake)
    monkeypatch.setattr(mr, "sys", _FakeSys(tty=True))
    res = runner.invoke(mr.app, ["delete", "99", "--mr", MR_REF], input="y\n")
    assert res.exit_code == 0
    assert "note 99 удалена" in res.stdout
    assert ("delete_note", ("wb/sl-back", 1499, 99)) in fake.calls


def test_delete_confirm_abort(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    _install_client(monkeypatch, fake)
    monkeypatch.setattr(mr, "sys", _FakeSys(tty=True))
    res = runner.invoke(mr.app, ["delete", "99", "--mr", MR_REF], input="n\n")
    assert res.exit_code == 1
    assert all(name != "delete_note" for name, _ in fake.calls)


def test_delete_note_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["delete_note"] = GitLabAPIError("DELETE", "/x", 403, "forbidden")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["delete", "99", "--mr", MR_REF, "--yes"])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_delete_resolve_target_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient())
    res = runner.invoke(
        mr.app, ["delete", "99", "--mr", "https://gitlab.com/x/y/-/merge_requests/1"]
    )
    assert res.exit_code == 1
    assert "хост" in res.stderr


# ── resolve / unresolve ──────────────────────────────────────────────────────


def test_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(discussions=[_DISC_OPEN])
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["resolve", "abc12345", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "discussion abc12345: resolved" in res.stdout
    assert ("set_resolved", ("wb/sl-back", 1499, _DISC_OPEN.id, True)) in fake.calls


def test_unresolve(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(discussions=[_DISC_OPEN])
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["unresolve", "abc12345", "--mr", MR_REF])
    assert res.exit_code == 0
    assert "discussion abc12345: unresolved" in res.stdout
    assert ("set_resolved", ("wb/sl-back", 1499, _DISC_OPEN.id, False)) in fake.calls


def test_resolve_non_resolvable(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_client(monkeypatch, FakeClient(discussions=[_DISC_GENERAL]))
    res = runner.invoke(mr.app, ["resolve", "def67890", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "нерезолвабельный" in res.stderr


# ── error-пути остальных подкоманд (except _CATCHABLE → _fail) ────────────────


def test_describe_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["set_description"] = GitLabAPIError("PUT", "/x", 403, "forbidden")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["describe", "--mr", MR_REF, "-m", "body"])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_diff_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["list_diffs"] = GitLabAPIError("GET", "/x", 500, "boom")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["diff", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_note_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["get_mr"] = GitLabAPIError("GET", "/x", 404, "nf")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["note", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_comments_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr())
    fake.errors["list_discussions"] = GitLabAPIError("GET", "/x", 500, "boom")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["comments", "--mr", MR_REF])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_reply_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient(mr=_mk_mr(), discussions=[_DISC_OPEN])
    fake.errors["reply"] = GitLabAPIError("POST", "/x", 403, "forbidden")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["reply", "abc12345", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr


def test_edit_gitlab_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    fake.errors["update_note"] = GitLabAPIError("PUT", "/x", 404, "nf")
    _install_client(monkeypatch, fake)
    res = runner.invoke(mr.app, ["edit", "17", "--mr", MR_REF, "-m", "x"])
    assert res.exit_code == 1
    assert "gitlab error" in res.stderr
