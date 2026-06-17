"""Тонкий клиент GitLab REST API v4 для code-review merge-request'ов.

Используется из `mpu mr`. По образцу `mpu/lib/kaiten.py`: чистые функции (парсинг
ссылок на MR, line-mapping unified-diff, сборка position-параметров, фильтры тредов)
отделены от I/O (`GitLabClient`, httpx) и покрыты тестами без сети — сам HTTP-клиент,
как kaiten/miro/slapi, тестами не покрывается.

Position-параметры инлайн-комментария GitLab принимает **form-encoded** скобочными
ключами (`position[base_sha]=…`). Вложенный JSON-объект инсталляция игнорирует молча —
комментарий создаётся, но непривязанным (наблюдалось с `glab api -f`), поэтому клиент
шлёт `data=` (application/x-www-form-urlencoded), не `json=`.

Правила привязки к строке (верифицированы против gitlab.btlz-api.ru):
added-строка → `new_line`; removed → `old_line`; context (неизменённая) → **обе**
`old_line`+`new_line`. `old_path`+`new_path` кладутся всегда — это закрывает rename.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, cast
from urllib.parse import quote, urlparse

import httpx

from mpu.lib import env

DEFAULT_BASE_URL = "https://gitlab.btlz-api.ru"
PER_PAGE = 100
MIN_DISCUSSION_PREFIX = 6

Side = Literal["new", "old"]


@dataclass
class DiffRefs:
    base_sha: str
    start_sha: str
    head_sha: str


@dataclass
class MrInfo:
    project: str  # "wb/sl-back" — прокидывается caller'ом, API в этом виде не возвращает
    iid: int
    title: str
    state: str
    source_branch: str
    target_branch: str
    web_url: str
    author_name: str
    author_username: str
    description: str
    diff_refs: DiffRefs | None  # None у MR без коммитов


@dataclass
class FileDiff:
    old_path: str
    new_path: str
    diff: str  # unified diff: hunks `@@ -A,B +C,D @@`; пустой у binary
    new_file: bool
    renamed_file: bool
    deleted_file: bool


@dataclass
class NotePosition:
    old_path: str | None
    new_path: str | None
    old_line: int | None
    new_line: int | None


@dataclass
class Note:
    id: int
    body: str
    author_name: str
    author_username: str
    created_at: str | None
    updated_at: str | None
    system: bool
    resolvable: bool
    resolved: bool
    type: str | None  # "DiffNote" (инлайн) | "DiscussionNote" | None
    position: NotePosition | None


@dataclass
class Discussion:
    id: str  # 40-hex
    individual_note: bool
    notes: list[Note]

    @property
    def resolvable(self) -> bool:
        return any(n.resolvable for n in self.notes)

    @property
    def resolved(self) -> bool:
        resolvable_notes = [n for n in self.notes if n.resolvable]
        return bool(resolvable_notes) and all(n.resolved for n in resolvable_notes)

    def location(self) -> NotePosition | None:
        """Позиция треда — position первой позиционированной ноты; None у general."""
        return next((n.position for n in self.notes if n.position is not None), None)


@dataclass(frozen=True)
class DiffLine:
    kind: Literal["added", "removed", "context"]
    old_line: int | None
    new_line: int | None


class GitLabAPIError(Exception):
    def __init__(self, method: str, path: str, status: int, body: str):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"gitlab {method} {path} -> {status}: {body[:300]}")


# ── Чистые хелперы (без I/O, тестируемые) ──────────────────────────────────────


def encode_project(project: str) -> str:
    """`wb/sl-back` → `wb%2Fsl-back` (URL-encoded project id для REST-путей)."""
    return quote(project, safe="")


def note_url(web_url: str, note_id: int) -> str:
    """Web-ссылка на конкретную ноту MR (якорь #note_<id>)."""
    return f"{web_url}#note_{note_id}"


def parse_mr_ref(ref: str, base_url: str) -> tuple[str | None, int | None]:
    """Селектор MR → (project, iid); недостающая часть — None (деривация из cwd снаружи).

    Формы: полный URL `<base_url>/<group>/<repo>/-/merge_requests/<iid>[/…][?…]`
    (URL чужого хоста → ValueError), `group/repo!iid`, голый `iid`.
    """
    s = ref.strip()
    if s.isdigit():
        return None, int(s)
    if s.startswith(("http://", "https://")):
        parsed = urlparse(s)
        expected = urlparse(base_url).netloc
        if parsed.netloc != expected:
            raise ValueError(f"хост MR-URL {parsed.netloc!r} != {expected!r} (GITLAB_BASE_URL)")
        marker = "/-/merge_requests/"
        left, sep, right = parsed.path.partition(marker)
        project = left.strip("/")
        iid_segment = right.split("/", 1)[0]
        if not sep or not project or not iid_segment.isdigit():
            raise ValueError(f"не удалось разобрать MR-URL {ref!r}")
        return project, int(iid_segment)
    if "!" in s:
        project, _, iid_str = s.rpartition("!")
        if not project or not iid_str.isdigit():
            raise ValueError(f"ожидается 'group/repo!iid', получено {ref!r}")
        return project, int(iid_str)
    raise ValueError(f"не удалось разобрать --mr {ref!r}; формы: URL | 'group/repo!iid' | iid")


_SCP_REMOTE_RE = re.compile(r"^(?:[\w.+-]+@)?([\w.-]+):(.+)$")


def project_from_remote_url(remote_url: str, expected_host: str) -> str:
    """URL из `git remote get-url origin` → project path (`wb/sl-back`).

    Поддержаны ssh://- (с портом), scp- (`git@host:path.git`) и https-формы.
    Хост, отличный от `expected_host` (например github-remote самого mpu) →
    ValueError с подсказкой указать --mr явно.
    """
    url = remote_url.strip()
    host: str | None = None
    path = ""
    if "://" in url:
        parsed = urlparse(url)
        host = parsed.hostname
        path = parsed.path
    else:
        m = _SCP_REMOTE_RE.match(url)
        if m:
            host = m.group(1)
            path = m.group(2)
    if not host or not path:
        raise ValueError(f"не удалось разобрать git remote {remote_url!r}")
    if host != expected_host:
        raise ValueError(
            f"git remote смотрит на {host!r}, а не на {expected_host!r} — укажи MR через --mr"
        )
    project = path.strip("/").removesuffix(".git")
    if not project:
        raise ValueError(f"пустой project в git remote {remote_url!r}")
    return project


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def parse_unified_diff(diff_text: str) -> list[DiffLine]:
    """Поле `diff` из GET …/diffs → плоский список строк с нумерацией обеих сторон.

    Контекстная строка может быть пустой (`""` вместо `" "`). `\\ No newline at end
    of file` и всё до первого hunk-заголовка пропускаются. Binary/пустой diff → [].
    """
    out: list[DiffLine] = []
    old_no = new_no = 0
    in_hunk = False
    for raw in diff_text.splitlines():
        m = _HUNK_RE.match(raw)
        if m:
            old_no = int(m.group(1))
            new_no = int(m.group(2))
            in_hunk = True
            continue
        if not in_hunk or raw.startswith("\\"):
            continue
        if raw.startswith("+"):
            out.append(DiffLine("added", None, new_no))
            new_no += 1
        elif raw.startswith("-"):
            out.append(DiffLine("removed", old_no, None))
            old_no += 1
        else:
            out.append(DiffLine("context", old_no, new_no))
            old_no += 1
            new_no += 1
    return out


def find_diff_line(lines: list[DiffLine], *, line: int, side: Side) -> DiffLine | None:
    """Строка диффа по номеру стороны. Removed не адресуется new-стороной (и наоборот):
    у неё нет номера на той стороне."""
    for diff_line in lines:
        number = diff_line.new_line if side == "new" else diff_line.old_line
        if number == line:
            return diff_line
    return None


def commentable_ranges(lines: list[DiffLine], side: Side) -> list[tuple[int, int]]:
    """Непрерывные диапазоны номеров стороны, к которым привязывается комментарий —
    для текста ошибки «строка вне диффа»."""
    numbers = sorted(
        number
        for diff_line in lines
        if (number := diff_line.new_line if side == "new" else diff_line.old_line) is not None
    )
    ranges: list[tuple[int, int]] = []
    for n in numbers:
        if ranges and n == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], n)
        else:
            ranges.append((n, n))
    return ranges


def format_ranges(ranges: list[tuple[int, int]]) -> str:
    """[(100, 112), (240, 240)] → `100-112, 240`."""
    return ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in ranges)


def diff_stat(diff_text: str) -> tuple[int, int]:
    """(added, removed) — число +/- строк в unified-diff файла (для сводки `mr files`)."""
    lines = parse_unified_diff(diff_text)
    added = sum(1 for dl in lines if dl.kind == "added")
    removed = sum(1 for dl in lines if dl.kind == "removed")
    return added, removed


def file_status(file_diff: FileDiff) -> str:
    """Статус файла в MR одной буквой: A(dded)/D(eleted)/R(enamed)/M(odified)."""
    if file_diff.new_file:
        return "A"
    if file_diff.deleted_file:
        return "D"
    if file_diff.renamed_file:
        return "R"
    return "M"


def build_position_params(
    diff_refs: DiffRefs, file_diff: FileDiff, target: DiffLine
) -> dict[str, str]:
    """Form-параметры positioned-комментария POST …/discussions.

    Строки по типу target: added → только `new_line`; removed → только `old_line`;
    context → обе (GitLab требует обе для неизменённых строк). Оба пути — всегда.
    """
    params: dict[str, str] = {
        "position[position_type]": "text",
        "position[base_sha]": diff_refs.base_sha,
        "position[start_sha]": diff_refs.start_sha,
        "position[head_sha]": diff_refs.head_sha,
        "position[old_path]": file_diff.old_path,
        "position[new_path]": file_diff.new_path,
    }
    if target.new_line is not None:
        params["position[new_line]"] = str(target.new_line)
    if target.old_line is not None:
        params["position[old_line]"] = str(target.old_line)
    return params


def match_discussion(discussions: list[Discussion], ref: str) -> Discussion:
    """Дискуссия по полному id (40-hex) или уникальному префиксу (≥6 символов)."""
    s = ref.strip().lower()
    for d in discussions:
        if d.id.lower() == s:
            return d
    if len(s) < MIN_DISCUSSION_PREFIX:
        raise ValueError(f"префикс id дискуссии короче {MIN_DISCUSSION_PREFIX} символов: {ref!r}")
    matches = [d for d in discussions if d.id.lower().startswith(s)]
    if not matches:
        raise ValueError(f"дискуссия {ref!r} не найдена в этом MR")
    if len(matches) > 1:
        ids = ", ".join(d.id[:12] for d in matches)
        raise ValueError(f"префикс {ref!r} неоднозначен: {ids}")
    return matches[0]


def filter_discussions(
    discussions: list[Discussion],
    *,
    unresolved: bool = False,
    file: str | None = None,
    author: str | None = None,
) -> list[Discussion]:
    """Треды для `mpu mr comments`: system-ноты выкинуты всегда (тред из одних
    system-нот — целиком); затем --unresolved / --file (substring по old/new path) /
    --author (substring по имени или username автора первой ноты, без регистра)."""
    out: list[Discussion] = []
    for d in discussions:
        notes = [n for n in d.notes if not n.system]
        if not notes:
            continue
        item = Discussion(id=d.id, individual_note=d.individual_note, notes=notes)
        if unresolved and (not item.resolvable or item.resolved):
            continue
        if file is not None:
            pos = item.location()
            paths = [p for p in ((pos.new_path, pos.old_path) if pos else ()) if p]
            if not any(file in p for p in paths):
                continue
        if author is not None:
            first = notes[0]
            haystack = f"{first.author_username} {first.author_name}".lower()
            if author.lower() not in haystack:
                continue
        out.append(item)
    return out


def _dict_items(raw_value: object) -> list[dict[str, Any]]:
    """Значение API → список dict-элементов (не список / не-dict элементы отбрасываются)."""
    if not isinstance(raw_value, list):
        return []
    items: list[dict[str, Any]] = []
    for entry in cast("list[object]", raw_value):
        if isinstance(entry, dict):
            items.append(cast("dict[str, Any]", entry))
    return items


def _parse_position(raw: object) -> NotePosition | None:
    if not isinstance(raw, dict):
        return None
    p = cast("dict[str, Any]", raw)
    return NotePosition(
        old_path=p.get("old_path"),
        new_path=p.get("new_path"),
        old_line=p.get("old_line"),
        new_line=p.get("new_line"),
    )


def parse_note(raw: dict[str, Any]) -> Note:
    """JSON-нота из discussions[].notes[] → Note. Недостающие поля → None/пусто."""
    author_raw = raw.get("author")
    author = cast("dict[str, Any]", author_raw) if isinstance(author_raw, dict) else {}
    return Note(
        id=int(raw["id"]),
        body=str(raw.get("body") or ""),
        author_name=str(author.get("name") or ""),
        author_username=str(author.get("username") or ""),
        created_at=raw.get("created_at"),
        updated_at=raw.get("updated_at"),
        system=bool(raw.get("system")),
        resolvable=bool(raw.get("resolvable")),
        resolved=bool(raw.get("resolved")),
        type=raw.get("type"),
        position=_parse_position(raw.get("position")),
    )


def parse_discussion(raw: dict[str, Any]) -> Discussion:
    """JSON-дискуссия из GET …/discussions → Discussion."""
    return Discussion(
        id=str(raw["id"]),
        individual_note=bool(raw.get("individual_note")),
        notes=[parse_note(n) for n in _dict_items(raw.get("notes"))],
    )


def parse_file_diff(raw: dict[str, Any]) -> FileDiff:
    """JSON-элемент GET …/diffs → FileDiff."""
    return FileDiff(
        old_path=str(raw.get("old_path") or ""),
        new_path=str(raw.get("new_path") or ""),
        diff=str(raw.get("diff") or ""),
        new_file=bool(raw.get("new_file")),
        renamed_file=bool(raw.get("renamed_file")),
        deleted_file=bool(raw.get("deleted_file")),
    )


def parse_mr_info(raw: dict[str, Any], project: str) -> MrInfo:
    """JSON MR (GET …/merge_requests/:iid) → MrInfo. `diff_refs` с null-SHA → None."""
    refs_raw = raw.get("diff_refs")
    diff_refs: DiffRefs | None = None
    if isinstance(refs_raw, dict):
        refs = cast("dict[str, Any]", refs_raw)
        base, start, head = refs.get("base_sha"), refs.get("start_sha"), refs.get("head_sha")
        if base and start and head:
            diff_refs = DiffRefs(base_sha=str(base), start_sha=str(start), head_sha=str(head))
    author_raw = raw.get("author")
    author = cast("dict[str, Any]", author_raw) if isinstance(author_raw, dict) else {}
    return MrInfo(
        project=project,
        iid=int(raw["iid"]),
        title=str(raw.get("title") or ""),
        state=str(raw.get("state") or ""),
        source_branch=str(raw.get("source_branch") or ""),
        target_branch=str(raw.get("target_branch") or ""),
        web_url=str(raw.get("web_url") or ""),
        author_name=str(author.get("name") or ""),
        author_username=str(author.get("username") or ""),
        description=str(raw.get("description") or ""),
        diff_refs=diff_refs,
    )


# ── I/O-клиент (HTTP, тестами не покрывается — как kaiten/miro/slapi) ───────────


class GitLabClient:
    def __init__(self, token: str, base_url: str = DEFAULT_BASE_URL):
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(
            base_url=f"{self.base_url}/api/v4",
            headers={"PRIVATE-TOKEN": token, "Accept": "application/json"},
            timeout=httpx.Timeout(30.0, connect=10.0),
            # Внутренний хост: не подхватывать системные *_PROXY (прецедент loki/portainer).
            trust_env=False,
        )

    @classmethod
    def from_env(cls) -> GitLabClient:
        """Собрать клиент из ~/.config/mpu/.env: GLAB_TOKEN (PAT, scope api) +
        GITLAB_BASE_URL (по умолчанию gitlab.btlz-api.ru)."""
        token = env.require("GLAB_TOKEN")
        base_url = env.get("GITLAB_BASE_URL") or DEFAULT_BASE_URL
        return cls(token=token, base_url=base_url)

    @property
    def host(self) -> str:
        """Голый хост инстанса (для сверки с git remote)."""
        return urlparse(self.base_url).hostname or ""

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
    ) -> Any:
        """HTTP-запрос к API v4. `data` уходит form-encoded — обязательное условие
        для скобочных `position[...]`-ключей. Не-2xx → GitLabAPIError."""
        try:
            resp = self._http.request(method, path, params=params, data=data)
        except httpx.HTTPError as e:
            raise GitLabAPIError(method, path, 0, str(e)) from None
        if not resp.is_success:
            raise GitLabAPIError(method, path, resp.status_code, resp.text)
        if not resp.content:
            return None
        return resp.json()

    def _get_paginated(
        self, path: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        """GET с пагинацией per_page=100 до неполной страницы."""
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            query = dict(params or {})
            query.update({"per_page": str(PER_PAGE), "page": str(page)})
            batch = _dict_items(self._request("GET", path, params=query))
            items.extend(batch)
            if len(batch) < PER_PAGE:
                return items
            page += 1

    def _mr_path(self, project: str, iid: int) -> str:
        return f"/projects/{encode_project(project)}/merge_requests/{iid}"

    def get_mr(self, project: str, iid: int) -> MrInfo:
        """GET …/merge_requests/:iid — заголовок MR + diff_refs (3 SHA для position)."""
        res = self._request("GET", self._mr_path(project, iid))
        return parse_mr_info(cast("dict[str, Any]", res), project)

    def find_open_mrs(self, project: str, branch: str) -> list[MrInfo]:
        """GET …/merge_requests?source_branch=&state=opened — открытые MR ветки."""
        res = self._get_paginated(
            f"/projects/{encode_project(project)}/merge_requests",
            {"source_branch": branch, "state": "opened"},
        )
        return [parse_mr_info(raw, project) for raw in res]

    def list_diffs(self, project: str, iid: int) -> list[FileDiff]:
        """GET …/changes?access_raw_diffs=true — изменённые файлы MR с полным diff.

        Не `/diffs`: тот в крупных MR отдаёт часть файлов свёрнутыми (`collapsed:true`,
        пустой `diff`), из-за чего терялись и сам дифф, и привязка инлайн-комментария к
        строке такого файла. `/changes` с raw-диффами возвращает всё одним ответом (без
        пагинации) и без свёртки."""
        res = self._request(
            "GET",
            f"{self._mr_path(project, iid)}/changes",
            params={"access_raw_diffs": "true"},
        )
        payload = cast("dict[str, Any]", res) if isinstance(res, dict) else {}
        return [parse_file_diff(raw) for raw in _dict_items(payload.get("changes"))]

    def list_discussions(self, project: str, iid: int) -> list[Discussion]:
        """GET …/discussions — все треды MR."""
        res = self._get_paginated(f"{self._mr_path(project, iid)}/discussions")
        return [parse_discussion(raw) for raw in res]

    def create_discussion(
        self, project: str, iid: int, body: str, position: dict[str, str] | None = None
    ) -> Discussion:
        """POST …/discussions — general-тред или (с position-параметрами) инлайн."""
        data = {"body": body}
        if position:
            data.update(position)
        res = self._request("POST", f"{self._mr_path(project, iid)}/discussions", data=data)
        return parse_discussion(cast("dict[str, Any]", res))

    def reply(self, project: str, iid: int, discussion_id: str, body: str) -> Note:
        """POST …/discussions/:id/notes — ответ в тред."""
        res = self._request(
            "POST",
            f"{self._mr_path(project, iid)}/discussions/{discussion_id}/notes",
            data={"body": body},
        )
        return parse_note(cast("dict[str, Any]", res))

    def update_note(self, project: str, iid: int, note_id: int, body: str) -> Note:
        """PUT …/notes/:note_id — заменить тело своей ноты."""
        res = self._request(
            "PUT", f"{self._mr_path(project, iid)}/notes/{note_id}", data={"body": body}
        )
        return parse_note(cast("dict[str, Any]", res))

    def delete_note(self, project: str, iid: int, note_id: int) -> None:
        """DELETE …/notes/:note_id."""
        self._request("DELETE", f"{self._mr_path(project, iid)}/notes/{note_id}")

    def set_resolved(self, project: str, iid: int, discussion_id: str, resolved: bool) -> None:
        """PUT …/discussions/:id?resolved= — резолв/анрезолв треда."""
        self._request(
            "PUT",
            f"{self._mr_path(project, iid)}/discussions/{discussion_id}",
            params={"resolved": "true" if resolved else "false"},
        )

    def set_description(self, project: str, iid: int, description: str) -> MrInfo:
        """PUT …/merge_requests/:iid — заменить описание MR; возвращает обновлённый MR."""
        res = self._request("PUT", self._mr_path(project, iid), data={"description": description})
        return parse_mr_info(cast("dict[str, Any]", res), project)

    def create_mr(
        self,
        project: str,
        source_branch: str,
        target_branch: str,
        title: str,
        description: str | None = None,
    ) -> MrInfo:
        """POST …/merge_requests — создать MR source_branch → target_branch."""
        data = {"source_branch": source_branch, "target_branch": target_branch, "title": title}
        if description:
            data["description"] = description
        res = self._request(
            "POST", f"/projects/{encode_project(project)}/merge_requests", data=data
        )
        return parse_mr_info(cast("dict[str, Any]", res), project)
