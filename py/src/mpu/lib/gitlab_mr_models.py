"""Pydantic-модели GitLab MR API + парсеры — типизированная граница `lib/gitlab_mr.py`.

Модуль импортируется ЛЕНИВО (паттерн lib/kaiten_models.py, см. CLAUDE.md «Стек»):
pydantic ~150 мс импорта, top-level импорт из commands/ запрещён.
`lib/gitlab_mr.py` реэкспортирует эти имена через модульный `__getattr__`.

Терпимость ручных парсеров сохранена: falsy строковое поле → "", не-dict вложенный
`author`/`position` → пусто/None, не-dict элементы `notes[]` отбрасываются,
`diff_refs` с любым null/пустым SHA → None.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from mpu.lib.jsonx import dict_items, is_dict, is_list


def _falsy_to_empty(v: object) -> object:
    """`str(raw.get(x) or "")` ручных парсеров: None/0/False/"" → ""."""
    return v if v else ""


EmptyStr = Annotated[str, BeforeValidator(_falsy_to_empty)]
TruthyBool = Annotated[bool, BeforeValidator(bool)]


def _member_names(raw: object) -> tuple[str, str]:
    """(name, username) из вложенного `author`-объекта; пусто, если нет/не dict."""
    if not is_dict(raw):
        return "", ""
    return str(raw.get("name") or ""), str(raw.get("username") or "")


class _ApiModel(BaseModel):
    """База wire-моделей: числа в строковых полях стрингифицируются (как str(x) раньше)."""

    model_config = ConfigDict(coerce_numbers_to_str=True)


class DiffRefs(_ApiModel):
    base_sha: str
    start_sha: str
    head_sha: str


class NotePosition(_ApiModel):
    old_path: str | None = None
    new_path: str | None = None
    old_line: int | None = None
    new_line: int | None = None


class Note(_ApiModel):
    id: int
    body: EmptyStr = ""
    author_name: str = ""
    author_username: str = ""
    created_at: str | None = None
    updated_at: str | None = None
    system: TruthyBool = False
    resolvable: TruthyBool = False
    resolved: TruthyBool = False
    type: str | None = None  # "DiffNote" (инлайн) | "DiscussionNote" | None
    position: NotePosition | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten_wire(cls, raw: object) -> object:
        """`author.{name,username}` → плоские поля; не-dict `position` → None.

        Уже плоские поля (прямое конструирование в тестах) не трогаем.
        """
        if not is_dict(raw):
            return raw
        out = dict(raw)
        if "author_name" not in out and "author_username" not in out:
            out["author_name"], out["author_username"] = _member_names(raw.get("author"))
        position = out.get("position")
        if not (position is None or is_dict(position) or isinstance(position, NotePosition)):
            out["position"] = None
        return out


class Discussion(_ApiModel):
    id: str  # 40-hex
    individual_note: TruthyBool = False
    notes: list[Note] = Field(default_factory=list[Note])

    @model_validator(mode="before")
    @classmethod
    def _keep_dict_notes(cls, raw: object) -> object:
        """Не-dict элементы wire `notes[]` отбрасываются (готовые Note — как есть);
        `notes` не-list → пустой список (терпимость ручного `_dict_items`)."""
        if not is_dict(raw) or "notes" not in raw:
            return raw
        notes = raw.get("notes")
        out = dict(raw)
        if is_list(notes):
            out["notes"] = [n for n in notes if is_dict(n) or isinstance(n, Note)]
        else:
            out["notes"] = []
        return out

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


class FileDiff(_ApiModel):
    old_path: EmptyStr = ""
    new_path: EmptyStr = ""
    diff: EmptyStr = ""  # unified diff: hunks `@@ -A,B +C,D @@`; пустой у binary
    new_file: TruthyBool = False
    renamed_file: TruthyBool = False
    deleted_file: TruthyBool = False


class MrInfo(_ApiModel):
    project: str  # "wb/sl-back" — прокидывается caller'ом, API в этом виде не возвращает
    iid: int
    title: EmptyStr = ""
    state: EmptyStr = ""
    source_branch: EmptyStr = ""
    target_branch: EmptyStr = ""
    web_url: EmptyStr = ""
    author_name: str = ""
    author_username: str = ""
    description: EmptyStr = ""
    diff_refs: DiffRefs | None = None  # None у MR без коммитов
    # Поля для `mpu glab-status` (есть в list-payload `/merge_requests`; default None,
    # чтобы не ломать конструирование MrInfo из get_mr/create_mr).
    project_id: int | None = None
    sha: str | None = None  # head исходной ветки на момент последнего апдейта
    merge_commit_sha: str | None = None
    squash_commit_sha: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten_wire(cls, raw: object) -> object:
        """`author` → плоские поля; `diff_refs` с null/пустым SHA → None; пустой SHA → None.

        Уже плоские поля (прямое конструирование в тестах) не трогаем.
        """
        if not is_dict(raw):
            return raw
        out = dict(raw)
        if "author_name" not in out and "author_username" not in out:
            out["author_name"], out["author_username"] = _member_names(raw.get("author"))
        refs = out.get("diff_refs")
        if is_dict(refs):
            if not (refs.get("base_sha") and refs.get("start_sha") and refs.get("head_sha")):
                out["diff_refs"] = None
        elif not isinstance(refs, DiffRefs):
            out["diff_refs"] = None
        for key in ("sha", "merge_commit_sha", "squash_commit_sha"):
            if key in out and not out[key]:
                out[key] = None
        return out


# ── Парсеры (публичные имена сохранены; реэкспорт — lib/gitlab_mr.py) ───────────


def parse_note(raw: object) -> Note:
    """JSON-нота из discussions[].notes[] → Note. Недостающие поля → None/пусто."""
    return Note.model_validate(raw)


def parse_discussion(raw: object) -> Discussion:
    """JSON-дискуссия из GET …/discussions → Discussion."""
    return Discussion.model_validate(raw)


def parse_file_diff(raw: object) -> FileDiff:
    """JSON-элемент GET …/diffs → FileDiff."""
    return FileDiff.model_validate(raw)


def parse_mr_info(raw: object, project: str) -> MrInfo:
    """JSON MR (GET …/merge_requests/:iid) → MrInfo. `diff_refs` с null-SHA → None."""
    wire = {**raw, "project": project} if is_dict(raw) else raw
    return MrInfo.model_validate(wire)


def parse_discussions(raw: object) -> list[Discussion]:
    """Список дискуссий (страница API) → list[Discussion]; не-dict элементы отброшены."""
    return [Discussion.model_validate(d) for d in dict_items(raw)]
