"""`mpu glab-status` — прохождение GitLab MR по веткам деплоя.

Одна таблица: строка — merge-request, колонки-ветки (`trunk`/`main`/`dev`/`qa`/
`predprod`/`prod`) — галочка `✅` там, куда merge-коммит MR уже попал (т.е. ветка
содержит этот коммит). Открытый (не смерженный) MR — строка без галочек.

Два режима:
- без аргументов — МОИ MR за окно `--since` (дефолт `7d` по `updated_at`) в репозиториях
  `sw-front, sl-front, sw-back, sl-back, mp-config-local` (группа `wb/`), состояния
  open + merged, сортировка `(репозиторий, id)`;
- с адресами MR — ровно эти MR, любых авторов и репозиториев, без окна и фильтра репо;
  над таблицей — шапка `project!iid · состояние · source → target`, под ней — «прочие
  ветки» (содержащие landing-коммит, но вне 6 колонок пайплайна).

Адаптивно по ширине терминала: при нехватке места обрезается только колонка `title`
(заголовок MR) с многоточием; остальные колонки и галочки остаются на месте.

ENV (~/.config/mpu/.env): GLAB_TOKEN — PAT со scope `api`; GITLAB_BASE_URL —
инстанс (по умолчанию https://gitlab.btlz-api.ru).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, NoReturn
from urllib.parse import urlparse

import typer
from rich.cells import cell_len, set_cell_size
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from mpu.lib import env
from mpu.lib.cli_err import fail
from mpu.lib.cli_out import print_json
from mpu.lib.duration import DurationParseError, parse_since
from mpu.lib.gitlab_mr import GitLabAPIError, GitLabClient, parse_mr_ref, project_from_cwd

if TYPE_CHECKING:
    # Только аннотации: runtime-импорт моделей тянет pydantic (~150 мс) в startup.
    from mpu.lib.gitlab_mr_models import MrInfo

COMMAND_NAME = "mpu glab-status"
COMMAND_SUMMARY = (
    "GitLab MR таблицей: галочки в колонках веток (trunk/main/dev/qa/predprod/prod) — "
    "куда merge-коммит MR уже долетел; без аргументов — мои MR за `--since`, "
    "с адресами MR — ровно эти MR (любых авторов); `--repos`, `--branches`, `--json`"
)

GROUP = "wb"
DEFAULT_REPOS = ("sw-front", "sl-front", "sw-back", "sl-back", "mp-config-local")
COLUMNS = ("trunk", "main", "dev", "qa", "predprod", "prod")
CHECK = "✅"
DEFAULT_SINCE = "7d"
_VISIBLE_STATES = {"opened", "merged"}
_MR_ARG_HINT = "укажи MR как 'group/repo!iid' или полным URL"

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


def other_branches(branch_names: Iterable[str], *, source_branch: str) -> list[str]:
    """Ветки с landing-коммитом вне COLUMNS — зеркало `landed_columns`.

    Своя ветка MR исключается: у смерженного fast-forward без squash landing-коммит —
    head исходной ветки, и она попала бы в «прочие» сразу под шапкой, где уже названа.
    Сортировка — ради идемпотентности вывода (порядок refs API не гарантирует)."""
    return sorted({name for name in branch_names if name not in COLUMNS and name != source_branch})


def mr_header(row: dict[str, Any]) -> str:
    """Строка над таблицей: `wb/sw-front!830 · merged · fix/x → dev`.

    Сегмент веток опускается, если обе пусты (MR без коммитов)."""
    segments = [f"{row['project']}!{row['iid']}", row["state"] or "?"]
    source, target = row["source_branch"], row["target_branch"]
    if source or target:
        segments.append(f"{source} → {target}")
    return " · ".join(segments)


def format_other_branches(names: list[str] | None, state: str, *, full: bool) -> str:
    """Ячейка подвала. `None` = refs не запрашивались (у несмерженного — by design,
    у merged без landing-sha/project_id — нет данных). По умолчанию печатается счётчик:
    refs merge-коммита содержат ВСЕ ветки, ответвлённые от целевой позже (десятки)."""
    if names is None:
        return "(MR не смержен)" if state != "merged" else "(нет данных)"
    if not names:
        return "(нет)"
    if full:
        return ", ".join(names)
    return f"{len(names)} (показать: --branches)"


def other_branches_report(rows: list[dict[str, Any]], *, full: bool) -> list[str]:
    """Подвал MR-отчёта: одна строка на один MR, блок с отбивкой — на несколько."""
    cells = [format_other_branches(r["other_branches"], r["state"], full=full) for r in rows]
    if len(rows) == 1:
        return [f"прочие ветки: {cells[0]}"]
    return ["прочие ветки:"] + [
        f"  {r['project']}!{r['iid']}: {cell}" for r, cell in zip(rows, cells, strict=True)
    ]


def conflicting_window_flags(since: str | None, repos: list[str] | None) -> list[str]:
    """Опции режима «мои MR», заданные явно — при адресах MR они бессмысленны."""
    flags: list[str] = []
    if since is not None:
        flags.append("--since")
    if repos is not None:
        flags.append("--repos")
    return flags


def dedupe_targets(targets: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """Схлопнуть повторы (`830` и `wb/x!830` из каталога x — один MR), сохранив порядок."""
    seen: set[tuple[str, int]] = set()
    result: list[tuple[str, int]] = []
    for target in targets:
        if target not in seen:
            seen.add(target)
            result.append(target)
    return result


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


def _fail(message: str, *, hint: str | None = None) -> NoReturn:
    fail(COMMAND_NAME, message, code=1, hint=hint)


def _err_msg(e: Exception, *, mr_mode: bool = False) -> str:
    if not isinstance(e, GitLabAPIError):
        return str(e)
    message = f"gitlab error: {e}"
    if e.status == 401:  # noqa: PLR2004
        message += f"; проверь GLAB_TOKEN в {env.env_path()}"
    elif mr_mode and e.status == 404:  # noqa: PLR2004
        # 404 приходит только из get_mr: commit_branch_names гасит его сама.
        message += "; проверь адрес MR (URL | 'group/repo!iid' | iid)"
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
    6 колонок его нет → пусто без лишнего запроса).

    Асимметрия намеренная: `landed` у несмерженного — `[]` (правда: ни в одну колонку
    не попал), `other_branches` — `None` (не знаем, refs не спрашивали). 404 от
    `commit_branch_names` (коммит уехал) приходит как `[]` — неотличимо от «веток нет»."""
    rows: list[dict[str, Any]] = []
    for mr in mrs:
        project = project_from_web_url(mr.web_url) or mr.project
        sha = landing_sha(mr)
        names: list[str] | None = None
        if mr.state == "merged" and sha and mr.project_id is not None:
            names = client.commit_branch_names(mr.project_id, sha)
        rows.append(
            {
                "repo": repo_short_name(project),
                "iid": mr.iid,
                "title": mr.title,
                "state": mr.state,
                "web_url": mr.web_url,
                "landed": landed_columns(names) if names is not None else [],
                "project": project or None,
                "source_branch": mr.source_branch,
                "target_branch": mr.target_branch,
                "other_branches": (
                    other_branches(names, source_branch=mr.source_branch)
                    if names is not None
                    else None
                ),
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


def _render_mr_report(rows: list[dict[str, Any]], *, full_branches: bool) -> None:
    """Шапки → пустая строка → таблица → подвал. Шапка и подвал печатаются `typer.echo`,
    а не через rich: plain-текст не парсит markup, поэтому имена веток и ветвей MR
    не могут внести разметку — безопасно by construction, а не за счёт `escape()`."""
    for row in rows:
        typer.echo(mr_header(row))
    typer.echo("")
    _render_table(rows)
    for line in other_branches_report(rows, full=full_branches):
        typer.echo(line)


def _resolve_ref(client: GitLabClient, ref: str) -> tuple[str, int]:
    """Адрес MR → (project, iid); проект без явного указания — из git remote cwd."""
    project, iid = parse_mr_ref(ref, client.base_url)  # ошибки парсинга сами называют ref
    if project is None:
        try:
            project = project_from_cwd(client.host, hint=_MR_ARG_HINT)
        except ValueError as e:
            # Ошибка git про ref не знает — иначе при нескольких MR не найти виноватого.
            raise ValueError(f"MR {ref!r}: {e}") from None
    return project, iid


def _rows_for_refs(client: GitLabClient, refs: list[str]) -> list[dict[str, Any]]:
    """Строки для явно названных MR — в порядке аргументов, повторы схлопнуты."""
    try:
        targets = dedupe_targets([_resolve_ref(client, ref) for ref in refs])
        mrs = [client.get_mr(project, iid) for project, iid in targets]
        return _build_rows(client, mrs)
    except (GitLabAPIError, ValueError) as e:
        _fail(_err_msg(e, mr_mode=True))


def _rows_for_window(
    client: GitLabClient, since: str | None, repos: list[str] | None
) -> list[dict[str, Any]]:
    """Строки для моих MR за окно `--since` в выбранных репозиториях."""
    try:
        since_ts = parse_since(since if since is not None else DEFAULT_SINCE)
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
        return _build_rows(client, mrs)
    except GitLabAPIError as e:
        _fail(_err_msg(e))


@app.command()
def main(
    mr_refs: Annotated[
        list[str] | None,
        typer.Argument(
            metavar="[MR]...",
            help="Адреса MR: URL | 'group/repo!iid' (в кавычках — `!` раскрывает shell) | iid "
            "(проект — из `git remote origin` ТЕКУЩЕГО каталога). Можно несколько, повторы "
            "схлопываются; показываются ровно эти MR — любых авторов и репозиториев. "
            "Без адресов — мои MR за окно --since",
        ),
    ] = None,
    since: Annotated[
        str | None,
        typer.Option(
            "--since",
            help="Окно по updated_at: 1h / 30m / 2d / unix-ts. Дефолт 7d. "
            "Только для режима «мои MR» — с адресом MR несовместимо",
        ),
    ] = None,
    repos: Annotated[
        list[str] | None,
        typer.Option(
            "--repos",
            help="Репозитории (короткое имя или group/repo; повторяемый и/или через запятую). "
            "Дефолт: sw-front, sl-front, sw-back, sl-back, mp-config-local. "
            "Только для режима «мои MR» — с адресом MR несовместимо",
        ),
    ] = None,
    branches: Annotated[
        bool,
        typer.Option(
            "--branches",
            help="Печатать «прочие ветки» полным списком вместо счётчика (только с адресом MR)",
        ),
    ] = False,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод (вместо таблицы)")] = False,
) -> None:
    """Таблица прохождения MR по веткам деплой-пайплайна.

    Без аргументов — мои MR за окно; с адресами MR — ровно эти MR (шапка + «прочие ветки»).

      mpu glab-status                                   # дефолт: 7d, 5 репо
      mpu glab-status --since 2d --repos sl-back,sw-back
      mpu glab-status 'wb/sw-front!830'                 # конкретный MR
      mpu glab-status 830                               # проект — из git remote cwd
      mpu glab-status 2117 'wb/sw-front!830' --branches # несколько MR, ветки списком
      mpu glab-status --json                            # машинный вывод (оба режима)

    Адрес, начинающийся с дефиса, отделять `--` (иначе click примет его за опцию).
    """
    refs = mr_refs or []
    if refs:
        conflicts = conflicting_window_flags(since, repos)
        if conflicts:
            flags = "/".join(conflicts)
            # Валидация до _client(): usage-ошибка не должна требовать GLAB_TOKEN.
            _fail(
                f"{flags} — только для режима «мои MR», с адресом MR не сочетается",
                hint=f"убрать {flags} либо вызвать mpu glab-status без адресов MR",
            )
    elif branches:
        _fail(
            "--branches применяется только с адресом MR",
            hint="указать адрес MR либо убрать флаг",
        )
    client = _client()
    rows = _rows_for_refs(client, refs) if refs else _rows_for_window(client, since, repos)
    if out_json:
        print_json(rows)
        return
    if refs:
        _render_mr_report(rows, full_branches=branches)
        return
    if not rows:
        typer.echo("(нет моих MR за интервал в выбранных репозиториях)", err=True)
        return
    _render_table(rows)
