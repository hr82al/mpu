"""`mpu mr` — чтение, создание, описание и ревью GitLab merge-request'а.

Подкоманды: `view`/`create`/`describe`/`files`/`diff`/`comment`/`note`/`comments`/
`show`/`reply`/`edit`/`delete`/`resolve`/`unresolve`.

Read (`view`/`files`/`diff`) дают
контекст без `glab`/curl; `create` — создать MR (source → target); `describe` —
заменить описание MR; пишущие-ревью — инлайн-комментарии и треды.
Зеркальные сценарии:

- ревьюер: `view`/`files`/`diff` — прочитать MR; `comment FILE:LINE` — комментарий
  под строкой кода; `note` — общий комментарий MR; `edit`/`delete` — правка своих
  нот; `reply`/`resolve`;
- автор по входящему ревью: `comments --unresolved` (что осталось поправить) или
  `comments --md` (всё ревью одним markdown-выводом) → правка кода → `reply` → `resolve`.

MR адресуется опцией `--mr`, одинаково у всех подкоманд:
  --mr https://gitlab.btlz-api.ru/wb/sl-back/-/merge_requests/1499
  --mr 'wb/sl-back!1499'   (одинарные кавычки: `!` раскрывается bash'ем)
  --mr 1499                (проект — из git remote текущего каталога)
  без --mr                 (плюс IID — из открытого MR текущей ветки)

LINE в `comment` — номер строки в **новой** версии файла (added/context); для
удалённой строки — номер в старой версии + флаг `--old`. Строка вне диффа MR →
ошибка с перечнем комментируемых диапазонов.

Примеры:
  mpu mr create --target predprod --title '[fix/123]: ...' -F /tmp/mr-desc.md  # создать MR
  mpu mr describe --mr 'wb/sl-back!1499' -F /tmp/mr-desc.md   # заменить описание MR
  mpu mr view --mr 'wb/sw-front!555'            # шапка + описание MR
  mpu mr files --mr 'wb/sw-front!555'           # изменённые файлы (+N/-M)
  mpu mr diff --mr 'wb/sw-front!555' --file oppiu  # дифф файлов по подстроке
  mpu mr comments --unresolved                  # что осталось поправить по ревью
  mpu mr comments --mr 'wb/sl-back!1499' --md   # всё ревью одним выводом (для LLM)
  mpu mr comment src/wb/wbTaxRates/wbTaxRates.types.js:64 -F /tmp/review.md
  echo "поправил в abc1234" | mpu mr reply e74e67b1 -F -
  mpu mr resolve e74e67b1
  mpu mr edit 17209 -m "новый текст"
  mpu mr delete 17209 --yes

ENV (~/.config/mpu/.env): GLAB_TOKEN — PAT со scope `api`; GITLAB_BASE_URL —
инстанс (по умолчанию https://gitlab.btlz-api.ru).
"""

from __future__ import annotations

import json as _json
import subprocess
import sys
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from mpu.lib import env
from mpu.lib.gitlab_mr import (
    Discussion,
    FileDiff,
    GitLabAPIError,
    GitLabClient,
    MrInfo,
    NotePosition,
    Side,
    build_position_params,
    commentable_ranges,
    diff_stat,
    file_status,
    filter_discussions,
    find_diff_line,
    format_ranges,
    match_discussion,
    note_url,
    parse_mr_ref,
    parse_unified_diff,
    project_from_remote_url,
)

COMMAND_NAME = "mpu mr"
COMMAND_SUMMARY = (
    "GitLab MR: `view`/`files`/`diff` — чтение MR; `create` — создать MR (source → target); "
    "`describe` — заменить описание MR; `comment FILE:LINE` — инлайн-комментарий под строкой "
    "диффа; `comments`/`show` — треды ревью; `reply`/`edit`/`delete`/`resolve`"
)

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)


class MrUsageError(Exception):
    """Доменная ошибка резолва MR/файла/строки. Не RuntimeError нарочно:
    `typer.Exit`/`click.Abort` наследуют RuntimeError, и except поймал бы их."""


_CATCHABLE = (GitLabAPIError, MrUsageError, ValueError)

MrRefOption = Annotated[
    str | None,
    typer.Option(
        "--mr",
        help="MR: URL | 'group/repo!iid' | iid; без флага — открытый MR текущей ветки",
    ),
]
MessageOption = Annotated[
    str | None, typer.Option("--message", "-m", help="Текст комментария (markdown)")
]
BodyFileOption = Annotated[
    str | None, typer.Option("--body-file", "-F", help="Файл с телом; `-` — stdin")
]
DiscussionArg = Annotated[
    str, typer.Argument(metavar="DISCUSSION", help="id дискуссии или уникальный префикс (≥6)")
]
NoteIdArg = Annotated[
    int, typer.Argument(metavar="NOTE_ID", help="id ноты (см. `comments --json`)")
]


# ── Чистые хелперы (тестируются в tests/test_mr.py) ────────────────────────────


def parse_location(location: str) -> tuple[str, int]:
    """`src/a.js:64` → (путь, строка). Разделитель — последний `:` (путь может
    содержать двоеточия); строка — положительное число."""
    path, sep, line_str = location.rpartition(":")
    if not sep or not path:
        raise typer.BadParameter(f"ожидается FILE:LINE, получено {location!r}")
    if not line_str.isdigit() or int(line_str) < 1:
        raise typer.BadParameter(f"LINE — положительное число, получено {location!r}")
    return path, int(line_str)


def resolve_body(
    message: str | None,
    body_file: str | None,
    *,
    stdin_read: Callable[[], str],
) -> str:
    """Тело из ровно одного источника: `-m TEXT` или `-F PATH` (`-` — stdin).
    Чистая функция: stdin приходит callback'ом, файл читается по пути."""
    if (message is None) == (body_file is None):
        raise typer.BadParameter("нужно ровно одно из -m/--message и -F/--body-file")
    if message is not None:
        body = message
    elif body_file == "-":
        body = stdin_read()
    else:
        try:
            body = Path(str(body_file)).read_text(encoding="utf-8")
        except OSError as e:
            raise typer.BadParameter(f"не удалось прочитать {body_file}: {e}") from None
    if not body.strip():
        raise typer.BadParameter("пустое тело комментария")
    return body


def position_label(pos: NotePosition | None) -> str:
    """`src/a.js:64` (new-сторона) / `src/a.js:60 (old)` (удалённая строка) / пусто."""
    if pos is None:
        return ""
    if pos.new_path and pos.new_line is not None:
        return f"{pos.new_path}:{pos.new_line}"
    if pos.old_path and pos.old_line is not None:
        return f"{pos.old_path}:{pos.old_line} (old)"
    return pos.new_path or pos.old_path or ""


def excerpt(body: str, width: int = 60) -> str:
    """Первая строка тела, обрезанная до width — ячейка EXCERPT таблицы."""
    stripped = body.strip()
    first = stripped.splitlines()[0] if stripped else ""
    return first if len(first) <= width else first[: width - 1] + "…"


def line_not_in_diff_message(file_diff: FileDiff, path: str, line: int, side: Side) -> str:
    """Текст ошибки «строка вне диффа» с диапазонами комментируемых строк."""
    message = f"{path}:{line} не входит в diff MR"
    if file_diff.deleted_file and side == "new":
        return f"{message}; файл удалён в MR — используй --old"
    ranges = commentable_ranges(parse_unified_diff(file_diff.diff), side)
    if not ranges:
        return f"{message}; на {side}-стороне нет комментируемых строк"
    hint = "" if side == "old" else " (строки старой версии — через --old)"
    return f"{message}; комментируемые {side}-строки: {format_ranges(ranges)}{hint}"


# ── I/O-хелперы ─────────────────────────────────────────────────────────────────


def _fail(sub: str, message: str) -> NoReturn:
    typer.echo(f"{COMMAND_NAME} {sub}: {message}", err=True)
    raise typer.Exit(code=1)


def _err_msg(e: Exception) -> str:
    if isinstance(e, GitLabAPIError):
        message = f"gitlab error: {e}"
        if e.status == 401:
            message += f"; проверь GLAB_TOKEN в {env.env_path()}"
        elif e.status == 404:
            message += "; проверь --mr (URL | 'group/repo!iid' | iid)"
        return message
    return str(e)


def _client(sub: str) -> GitLabClient:
    try:
        return GitLabClient.from_env()
    except RuntimeError as e:  # env.require: нет GLAB_TOKEN
        _fail(sub, str(e))


def _git(*args: str) -> str:
    try:
        proc = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
    except FileNotFoundError:
        raise MrUsageError("git не найден в PATH — укажи MR через --mr") from None
    except subprocess.CalledProcessError as e:
        detail = (e.stderr or "").strip() or f"git {' '.join(args)}: ошибка"
        raise MrUsageError(f"{detail} — укажи MR через --mr") from None
    return proc.stdout.strip()


def _resolve_target(client: GitLabClient, mr_ref: str | None) -> tuple[str, int]:
    """(project, iid) из --mr; недостающее — из cwd: проект из git remote origin,
    IID из единственного открытого MR текущей ветки."""
    project: str | None = None
    iid: int | None = None
    if mr_ref is not None:
        project, iid = parse_mr_ref(mr_ref, client.base_url)
    if project is None:
        project = project_from_remote_url(_git("remote", "get-url", "origin"), client.host)
    if iid is None:
        branch = _git("rev-parse", "--abbrev-ref", "HEAD")
        if branch == "HEAD":
            raise MrUsageError("detached HEAD — не определить ветку, укажи MR через --mr")
        mrs = client.find_open_mrs(project, branch)
        if not mrs:
            raise MrUsageError(f"нет открытого MR ветки {branch!r} в {project} — укажи --mr")
        if len(mrs) > 1:
            variants = "; ".join(f"{project}!{m.iid} {m.title}" for m in mrs)
            raise MrUsageError(f"несколько открытых MR ветки {branch!r}: {variants} — укажи --mr")
        iid = mrs[0].iid
    return project, iid


def _find_file_diff(diffs: list[FileDiff], path: str) -> FileDiff:
    """FileDiff по пути (new- или old-стороны — закрывает rename). Нет → MrUsageError
    со списком изменённых файлов."""
    for file_diff in diffs:
        if path in (file_diff.new_path, file_diff.old_path):
            return file_diff
    changed = sorted({fd.new_path or fd.old_path for fd in diffs})
    listed = ", ".join(changed[:20]) + ("…" if len(changed) > 20 else "")
    raise MrUsageError(f"файл {path!r} не изменён в этом MR; изменённые: {listed}")


def _discussion_payload(d: Discussion) -> dict[str, Any]:
    return {
        "id": d.id,
        "resolvable": d.resolvable,
        "resolved": d.resolved,
        "location": position_label(d.location()) or None,
        "notes": [asdict(n) for n in d.notes],
    }


def _note_header(d_note: Any) -> str:
    when = (d_note.created_at or "")[:16].replace("T", " ")
    name = d_note.author_name or d_note.author_username
    return f"**{name}** (@{d_note.author_username}) · note {d_note.id} · {when}"


def _discussion_status(d: Discussion) -> str:
    if not d.resolvable:
        return "note"
    return "resolved" if d.resolved else "open"


def _comments_markdown(mr: MrInfo, discussions: list[Discussion]) -> str:
    lines = [f"# MR {mr.project}!{mr.iid} — {mr.title} [{mr.state}]", ""]
    for d in discussions:
        location = position_label(d.location()) or "general"
        lines.append(f"## {d.id[:8]} · {location} · {_discussion_status(d)}")
        lines.append("")
        for n in d.notes:
            lines.extend([_note_header(n), "", n.body, ""])
        lines.extend(["---", ""])
    return "\n".join(lines)


def _print_created(mr: MrInfo, discussion: Discussion, label: str) -> None:
    first = discussion.notes[0] if discussion.notes else None
    typer.echo(f"создано: discussion {discussion.id[:8]}{label}")
    if first is not None:
        typer.echo(note_url(mr.web_url, first.id))


def _file_rows(diffs: list[FileDiff]) -> list[dict[str, Any]]:
    """Сводка по каждому изменённому файлу: статус + (added, removed) строк."""
    rows: list[dict[str, Any]] = []
    for fd in diffs:
        added, removed = diff_stat(fd.diff)
        rows.append(
            {
                "status": file_status(fd),
                "old_path": fd.old_path,
                "new_path": fd.new_path,
                "additions": added,
                "deletions": removed,
            }
        )
    return rows


def _file_label(row: dict[str, Any]) -> str:
    """`old → new` для переименования, иначе путь новой (или старой) версии."""
    if row["status"] == "R" and row["old_path"] != row["new_path"]:
        return f"{row['old_path']} → {row['new_path']}"
    return row["new_path"] or row["old_path"]


def _diff_file_header(fd: FileDiff) -> str:
    """Заголовок-разделитель файла в выводе `diff` (в стиле `diff --git`)."""
    note = {"A": "new file", "D": "deleted file", "R": "renamed"}.get(file_status(fd))
    header = f"diff --git a/{fd.old_path} b/{fd.new_path}"
    return f"{header}  [{note}]" if note else header


# ── Подкоманды ──────────────────────────────────────────────────────────────────


@app.command("view")
def view(
    mr_ref: MrRefOption = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON (машинный)")] = False,
):
    """Шапка MR: заголовок, автор, ветки, состояние, описание."""
    client = _client("view")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.get_mr(project, iid)
    except _CATCHABLE as e:
        _fail("view", _err_msg(e))
    if out_json:
        typer.echo(_json.dumps(asdict(mr), ensure_ascii=False, indent=2))
        return
    typer.echo(f"MR {mr.project}!{mr.iid} — {mr.title} [{mr.state}]")
    typer.echo(f"author: {mr.author_name or mr.author_username} (@{mr.author_username})")
    typer.echo(f"branch: {mr.source_branch} → {mr.target_branch}")
    typer.echo(f"url:    {mr.web_url}")
    if mr.description.strip():
        typer.echo("")
        typer.echo(mr.description.rstrip())


@app.command("create")
def create(
    title: Annotated[str, typer.Option("--title", help="Заголовок MR")],
    target: Annotated[str, typer.Option("--target", help="Целевая ветка (target_branch)")],
    source: Annotated[
        str | None, typer.Option("--source", help="Исходная ветка; по умолчанию — текущая")
    ] = None,
    project_opt: Annotated[
        str | None,
        typer.Option("--project", help="group/repo; по умолчанию — из git remote origin cwd"),
    ] = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
):
    """Создать MR (source → target). Описание из -m/-F опционально (`-F -` — stdin)."""
    description = ""
    if message is not None or body_file is not None:
        description = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    client = _client("create")
    try:
        project = project_opt or project_from_remote_url(
            _git("remote", "get-url", "origin"), client.host
        )
        src = source or _git("rev-parse", "--abbrev-ref", "HEAD")
        if src == "HEAD":
            raise MrUsageError("detached HEAD — укажи --source")
        mr = client.create_mr(project, src, target, title, description)
    except _CATCHABLE as e:
        _fail("create", _err_msg(e))
    typer.echo(f"создан MR {mr.project}!{mr.iid} — {mr.title} [{mr.state}]")
    typer.echo(f"branch: {mr.source_branch} → {mr.target_branch}")
    typer.echo(mr.web_url)


@app.command("describe")
def describe(
    mr_ref: MrRefOption = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
):
    """Заменить описание MR (тело из -m/-F; `-F -` — stdin)."""
    body = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    client = _client("describe")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.set_description(project, iid, body)
    except _CATCHABLE as e:
        _fail("describe", _err_msg(e))
    typer.echo(f"описание MR {mr.project}!{mr.iid} обновлено")
    typer.echo(mr.web_url)


@app.command("files")
def files(
    mr_ref: MrRefOption = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON (машинный)")] = False,
):
    """Изменённые файлы MR: статус (A/D/R/M) и счётчик строк (+N/-M)."""
    client = _client("files")
    try:
        project, iid = _resolve_target(client, mr_ref)
        rows = _file_rows(client.list_diffs(project, iid))
    except _CATCHABLE as e:
        _fail("files", _err_msg(e))
    if out_json:
        typer.echo(_json.dumps(rows, ensure_ascii=False, indent=2))
        return
    table = Table(header_style="bold")
    for column in ("ST", "+", "-", "FILE"):
        table.add_column(column)
    for row in rows:
        # escape: пути с `[id]`-сегментами Rich иначе примет за markup-теги.
        table.add_row(
            row["status"], f"+{row['additions']}", f"-{row['deletions']}", escape(_file_label(row))
        )
    Console().print(table)
    added = sum(r["additions"] for r in rows)
    removed = sum(r["deletions"] for r in rows)
    typer.echo(f"({len(rows)} files, +{added} / -{removed})")


@app.command("diff")
def diff(
    mr_ref: MrRefOption = None,
    file_filter: Annotated[
        str | None, typer.Option("--file", help="Substring-фильтр по пути файла")
    ] = None,
    out_json: Annotated[
        bool, typer.Option("--json", help="JSON (машинный, список FileDiff)")
    ] = False,
):
    """Unified-diff MR: все файлы или только подходящие под `--file SUBSTR`."""
    client = _client("diff")
    try:
        project, iid = _resolve_target(client, mr_ref)
        diffs = client.list_diffs(project, iid)
    except _CATCHABLE as e:
        _fail("diff", _err_msg(e))
    if file_filter is not None:
        diffs = [fd for fd in diffs if file_filter in fd.new_path or file_filter in fd.old_path]
        if not diffs:
            _fail("diff", f"нет изменённых файлов по подстроке {file_filter!r}")
    if out_json:
        typer.echo(_json.dumps([asdict(fd) for fd in diffs], ensure_ascii=False, indent=2))
        return
    if not diffs:
        typer.echo("(MR без изменённых файлов)")
        return
    blocks: list[str] = []
    for fd in diffs:
        body = fd.diff.rstrip("\n") if fd.diff else "(binary / без текстового диффа)"
        blocks.append(f"{_diff_file_header(fd)}\n{body}")
    typer.echo("\n\n".join(blocks))


@app.command("comment")
def comment(
    location: Annotated[
        str, typer.Argument(metavar="FILE:LINE", help="Строка диффа, например src/a.js:64")
    ],
    mr_ref: MrRefOption = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
    old: Annotated[
        bool, typer.Option("--old", help="LINE — номер старой стороны (удалённая строка)")
    ] = False,
):
    """Инлайн-комментарий под строкой диффа (новая дискуссия)."""
    path, line = parse_location(location)
    body = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    side: Side = "old" if old else "new"
    client = _client("comment")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.get_mr(project, iid)
        if mr.diff_refs is None:
            raise MrUsageError(f"у MR {project}!{iid} нет diff (MR без коммитов)")
        file_diff = _find_file_diff(client.list_diffs(project, iid), path)
        target = find_diff_line(parse_unified_diff(file_diff.diff), line=line, side=side)
        if target is None:
            raise MrUsageError(line_not_in_diff_message(file_diff, path, line, side))
        position = build_position_params(mr.diff_refs, file_diff, target)
        discussion = client.create_discussion(project, iid, body, position)
    except _CATCHABLE as e:
        _fail("comment", _err_msg(e))
    _print_created(mr, discussion, f" на {path}:{line}")


@app.command("note")
def note(
    mr_ref: MrRefOption = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
):
    """Общий комментарий MR (тред без привязки к строке)."""
    body = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    client = _client("note")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.get_mr(project, iid)
        discussion = client.create_discussion(project, iid, body)
    except _CATCHABLE as e:
        _fail("note", _err_msg(e))
    _print_created(mr, discussion, "")


@app.command("comments")
def comments(
    mr_ref: MrRefOption = None,
    unresolved: Annotated[
        bool, typer.Option("--unresolved", help="Только нерезолвленные треды")
    ] = False,
    file_filter: Annotated[
        str | None, typer.Option("--file", help="Substring-фильтр по пути файла")
    ] = None,
    author_filter: Annotated[
        str | None, typer.Option("--author", help="Substring-фильтр по автору первой ноты")
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON (машинный)")] = False,
    out_md: Annotated[
        bool, typer.Option("--md", help="Полные тела тредов одним markdown-выводом")
    ] = False,
):
    """Треды ревью MR: таблица; `--md` — тела целиком; `--json` — машинно."""
    client = _client("comments")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.get_mr(project, iid)
        discussions = filter_discussions(
            client.list_discussions(project, iid),
            unresolved=unresolved,
            file=file_filter,
            author=author_filter,
        )
    except _CATCHABLE as e:
        _fail("comments", _err_msg(e))
    if out_json:
        payload = [_discussion_payload(d) for d in discussions]
        typer.echo(_json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if out_md:
        typer.echo(_comments_markdown(mr, discussions))
        return
    typer.echo(f"MR {mr.project}!{mr.iid} — {mr.title} [{mr.state}]")
    table = Table(header_style="bold")
    for column in ("DISC", "RES", "LOCATION", "AUTHOR", "NOTES", "EXCERPT"):
        table.add_column(column)
    for d in discussions:
        first = d.notes[0]
        table.add_row(
            d.id[:8],
            {"resolved": "✓", "open": "·", "note": ""}[_discussion_status(d)],
            position_label(d.location()),
            first.author_username or first.author_name,
            str(len(d.notes)),
            excerpt(first.body),
        )
    Console().print(table)
    open_count = sum(1 for d in discussions if d.resolvable and not d.resolved)
    typer.echo(f"({len(discussions)} discussions, {open_count} unresolved)")


@app.command("show")
def show(
    discussion_ref: DiscussionArg,
    mr_ref: MrRefOption = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON (машинный)")] = False,
):
    """Один тред целиком — все ноты verbatim."""
    client = _client("show")
    try:
        project, iid = _resolve_target(client, mr_ref)
        discussions = filter_discussions(client.list_discussions(project, iid))
        d = match_discussion(discussions, discussion_ref)
    except _CATCHABLE as e:
        _fail("show", _err_msg(e))
    if out_json:
        typer.echo(_json.dumps(_discussion_payload(d), ensure_ascii=False, indent=2))
        return
    location = position_label(d.location()) or "general"
    typer.echo(f"discussion {d.id} · {location} · {_discussion_status(d)}")
    for n in d.notes:
        typer.echo("")
        typer.echo(_note_header(n))
        typer.echo(n.body)


@app.command("reply")
def reply(
    discussion_ref: DiscussionArg,
    mr_ref: MrRefOption = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
):
    """Ответ в существующий тред."""
    body = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    client = _client("reply")
    try:
        project, iid = _resolve_target(client, mr_ref)
        mr = client.get_mr(project, iid)
        discussions = filter_discussions(client.list_discussions(project, iid))
        d = match_discussion(discussions, discussion_ref)
        created = client.reply(project, iid, d.id, body)
    except _CATCHABLE as e:
        _fail("reply", _err_msg(e))
    typer.echo(f"reply: note {created.id} в discussion {d.id[:8]}")
    typer.echo(note_url(mr.web_url, created.id))


@app.command("edit")
def edit(
    note_id: NoteIdArg,
    mr_ref: MrRefOption = None,
    message: MessageOption = None,
    body_file: BodyFileOption = None,
):
    """Заменить тело своей ноты."""
    body = resolve_body(message, body_file, stdin_read=sys.stdin.read)
    client = _client("edit")
    try:
        project, iid = _resolve_target(client, mr_ref)
        client.update_note(project, iid, note_id, body)
    except _CATCHABLE as e:
        _fail("edit", _err_msg(e))
    typer.echo(f"note {note_id} обновлена")


@app.command("delete")
def delete(
    note_id: NoteIdArg,
    mr_ref: MrRefOption = None,
    yes: Annotated[bool, typer.Option("--yes", help="Удалить без подтверждения")] = False,
):
    """Удалить свою ноту."""
    client = _client("delete")
    try:
        project, iid = _resolve_target(client, mr_ref)
    except _CATCHABLE as e:
        _fail("delete", _err_msg(e))
    if not yes:
        if not sys.stdin.isatty():
            _fail("delete", "нет TTY для подтверждения — добавь --yes")
        typer.confirm(f"Удалить note {note_id} в {project}!{iid}?", abort=True)
    try:
        client.delete_note(project, iid, note_id)
    except GitLabAPIError as e:
        _fail("delete", _err_msg(e))
    typer.echo(f"note {note_id} удалена")


def _set_resolved(sub: str, discussion_ref: str, mr_ref: str | None, resolved: bool) -> None:
    client = _client(sub)
    try:
        project, iid = _resolve_target(client, mr_ref)
        discussions = filter_discussions(client.list_discussions(project, iid))
        d = match_discussion(discussions, discussion_ref)
        if not d.resolvable:
            raise MrUsageError(f"тред {d.id[:8]} нерезолвабельный (general note)")
        client.set_resolved(project, iid, d.id, resolved)
    except _CATCHABLE as e:
        _fail(sub, _err_msg(e))
    typer.echo(f"discussion {d.id[:8]}: {'resolved' if resolved else 'unresolved'}")


@app.command("resolve")
def resolve(discussion_ref: DiscussionArg, mr_ref: MrRefOption = None):
    """Пометить тред решённым."""
    _set_resolved("resolve", discussion_ref, mr_ref, resolved=True)


@app.command("unresolve")
def unresolve(discussion_ref: DiscussionArg, mr_ref: MrRefOption = None):
    """Снять отметку решённого."""
    _set_resolved("unresolve", discussion_ref, mr_ref, resolved=False)
