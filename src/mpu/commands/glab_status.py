"""`mpu glab-status` — обзор моих GitLab MR и их прохождения по веткам деплоя.

Одна таблица: строка — мой merge-request, колонки-ветки (`trunk`/`main`/`dev`/`qa`/
`predprod`/`prod`) — галочка `✅` там, куда merge-коммит MR уже попал (т.е. ветка
содержит этот коммит). Открытый (не смерженный) MR — строка без галочек.

По умолчанию: окно `7d` (последняя неделя по `updated_at`), репозитории
`sw-front, sl-front, sw-back, sl-back, mp-config-local` (группа `wb/`), состояния
open + merged. Сортировка — `(репозиторий, id)`. Репо без MR за интервал строк не дают.

Адаптивно по ширине терминала: при нехватке места обрезается только колонка `title`
(заголовок MR) с многоточием; остальные колонки и галочки остаются на месте.

Примеры:
  mpu glab-status                              # дефолт: 7d, 5 репо, таблица
  mpu glab-status --since 2d                   # окно — последние 2 дня
  mpu glab-status --repos sl-back,sw-back      # только эти репозитории
  mpu glab-status --repos sl-back --repos sw-back   # то же повторяемым флагом
  mpu glab-status --json                       # машинный вывод

ENV (~/.config/mpu/.env): GLAB_TOKEN — PAT со scope `api`; GITLAB_BASE_URL —
инстанс (по умолчанию https://gitlab.btlz-api.ru).
"""

from __future__ import annotations

import json as _json
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn
from urllib.parse import urlparse

import typer
from rich.cells import cell_len, set_cell_size
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from mpu.lib import env
from mpu.lib.duration import DurationParseError, parse_since
from mpu.lib.gitlab_mr import GitLabAPIError, GitLabClient, MrInfo

COMMAND_NAME = "mpu glab-status"
COMMAND_SUMMARY = (
    "Мои GitLab MR таблицей: галочки в колонках веток (trunk/main/dev/qa/predprod/prod) — "
    "куда merge-коммит MR уже долетел; `--since`, `--repos`, `--json`"
)

GROUP = "wb"
DEFAULT_REPOS = ("sw-front", "sl-front", "sw-back", "sl-back", "mp-config-local")
COLUMNS = ("trunk", "main", "dev", "qa", "predprod", "prod")
CHECK = "✅"
_VISIBLE_STATES = {"opened", "merged"}

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


# ── Чистые хелперы (тестируются в tests/test_glab_status.py) ────────────────────


def project_from_web_url(web_url: str) -> str | None:
    """`https://host/wb/sl-back/-/merge_requests/9` → `wb/sl-back`; без маркера → None."""
    left, sep, _ = urlparse(web_url).path.partition("/-/")
    project = left.strip("/")
    if not sep or not project:
        return None
    return project


def repo_short_name(project: str) -> str:
    """`wb/sl-back` → `sl-back`."""
    return project.rsplit("/", 1)[-1]


def resolve_repos(repos: list[str] | None) -> set[str]:
    """Список репо (короткие имена / пути, в т.ч. через запятую) → множество
    project-путей `wb/<name>`. None/пусто → DEFAULT_REPOS."""
    raw = repos if repos else list(DEFAULT_REPOS)
    result: set[str] = set()
    for item in raw:
        for part in item.split(","):
            name = part.strip()
            if name:
                result.add(name if "/" in name else f"{GROUP}/{name}")
    return result


def landing_sha(mr: MrInfo) -> str | None:
    """Коммит, по которому судим о попадании в ветки: merge-commit → squash → head."""
    return mr.merge_commit_sha or mr.squash_commit_sha or mr.sha


def landed_columns(branch_names: Iterable[str]) -> list[str]:
    """Пересечение веток (из refs коммита) с COLUMNS, в порядке COLUMNS."""
    present = set(branch_names)
    return [column for column in COLUMNS if column in present]


def fit_title(title: str, budget: int) -> str:
    """Обрезать title до budget терминальных ячеек (emoji=2 ячейки) с хвостом `…`.

    budget<=0 → пусто; помещается целиком → как есть. Ширина — по rich.cell_len,
    не по len (иначе широкие глифы недосчитываются)."""
    if budget <= 0:
        return ""
    if cell_len(title) <= budget:
        return title
    if budget == 1:
        return "…"
    return set_cell_size(title, budget - 1) + "…"


def mr_sort_key(mr: MrInfo) -> tuple[str, int]:
    """Ключ сортировки таблицы: (короткое имя репо, iid)."""
    project = project_from_web_url(mr.web_url) or mr.project
    return (repo_short_name(project), mr.iid)


def title_budget(console_width: int, rows: list[dict[str, Any]]) -> int:
    """Сколько терминальных ячеек остаётся под колонку title после фиксированных
    колонок (repo, id, 6 веток) и хрома rich-таблицы (бордеры + паддинги)."""
    repo_w = max([cell_len("repo"), *(cell_len(r["repo"]) for r in rows)])
    id_w = max([cell_len("id"), *(cell_len(str(r["iid"])) for r in rows)])
    branches_w = sum(max(cell_len(column), cell_len(CHECK)) for column in COLUMNS)
    num_columns = 3 + len(COLUMNS)  # repo, id, title + ветки
    chrome = 3 * num_columns + 1  # default-box: (n+1) бордеров + 2n паддингов
    return console_width - chrome - repo_w - id_w - branches_w


# ── I/O-хелперы ─────────────────────────────────────────────────────────────────


def _fail(message: str) -> NoReturn:
    typer.echo(f"{COMMAND_NAME}: {message}", err=True)
    raise typer.Exit(code=1)


def _err_msg(e: GitLabAPIError) -> str:
    message = f"gitlab error: {e}"
    if e.status == 401:
        message += f"; проверь GLAB_TOKEN в {env.env_path()}"
    return message


def _client() -> GitLabClient:
    try:
        return GitLabClient.from_env()
    except RuntimeError as e:  # env.require: нет GLAB_TOKEN
        _fail(str(e))


def _iso_utc(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_rows(client: GitLabClient, mrs: list[MrInfo]) -> list[dict[str, Any]]:
    """Для каждого MR — строка с пометкой веток, куда он долетел. refs запрашиваем
    только у смерженных (у открытого landing-коммит — head ветки, ни в одной из
    6 колонок его нет → пусто без лишнего запроса)."""
    rows: list[dict[str, Any]] = []
    for mr in mrs:
        project = project_from_web_url(mr.web_url) or mr.project
        sha = landing_sha(mr)
        landed: list[str] = []
        if mr.state == "merged" and sha and mr.project_id is not None:
            landed = landed_columns(client.commit_branch_names(mr.project_id, sha))
        rows.append(
            {
                "repo": repo_short_name(project),
                "iid": mr.iid,
                "title": mr.title,
                "state": mr.state,
                "web_url": mr.web_url,
                "landed": landed,
            }
        )
    return rows


def _render_table(rows: list[dict[str, Any]]) -> None:
    console = Console()
    budget = title_budget(console.width, rows)
    table = Table(header_style="bold")
    table.add_column("repo", no_wrap=True)
    table.add_column("id", justify="right", no_wrap=True)
    table.add_column("title", no_wrap=True, overflow="ellipsis")
    for column in COLUMNS:
        table.add_column(column, justify="center", no_wrap=True)
    for r in rows:
        landed = set(r["landed"])
        marks = [CHECK if column in landed else "" for column in COLUMNS]
        # escape: заголовки MR с `[fix/123]` иначе уйдут в rich-markup.
        table.add_row(r["repo"], str(r["iid"]), escape(fit_title(r["title"], budget)), *marks)
    console.print(table)


@app.command()
def main(
    since: Annotated[
        str,
        typer.Option("--since", help="Окно по updated_at: 1h / 30m / 2d / unix-ts. Дефолт 7d"),
    ] = "7d",
    repos: Annotated[
        list[str] | None,
        typer.Option(
            "--repos",
            help="Репозитории (короткое имя или group/repo; повторяемый и/или через запятую). "
            "Дефолт: sw-front, sl-front, sw-back, sl-back, mp-config-local",
        ),
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод (вместо таблицы)")] = False,
) -> None:
    """Мои MR таблицей с галочками прохождения по веткам деплой-пайплайна."""
    client = _client()
    try:
        since_ts = parse_since(since)
    except DurationParseError as e:
        _fail(f"--since: {e}")
    selected = resolve_repos(repos)
    try:
        all_mrs = client.list_my_merge_requests(_iso_utc(since_ts))
    except GitLabAPIError as e:
        _fail(_err_msg(e))
    mrs = [
        mr
        for mr in all_mrs
        if mr.state in _VISIBLE_STATES and (project_from_web_url(mr.web_url) or "") in selected
    ]
    mrs.sort(key=mr_sort_key)
    try:
        rows = _build_rows(client, mrs)
    except GitLabAPIError as e:
        _fail(_err_msg(e))
    if out_json:
        typer.echo(_json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        typer.echo("(нет моих MR за интервал в выбранных репозиториях)", err=True)
        return
    _render_table(rows)
