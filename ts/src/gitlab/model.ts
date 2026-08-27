/**
 * Формы ответов GitLab MR API (`platform/gitlab-api.md`, «Данные
 * ответов»): нормализация шапки MR, файлов и дискуссий.
 *
 * Модуль читает сырые объекты ответа и отдаёт значения, на которые
 * опираются команды. Сеть, пагинация и адресация сюда не входят: здесь
 * только правила формы — какой ключ откуда берётся и что означает его
 * отсутствие.
 */

import { countDiff } from "./diff.ts";

/** Сырой JSON-объект ответа: ключи проверяются по одному. */
export type RawObject = Readonly<Record<string, unknown>>;

/** Три SHA диффа; неполного набора не бывает (спека). */
export interface DiffRefs {
  readonly base_sha: string;
  readonly start_sha: string;
  readonly head_sha: string;
}

/** Шапка MR в форме вывода `mr view --json`. */
export interface MergeRequest {
  readonly project: string;
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly source_branch: string;
  readonly target_branch: string;
  readonly web_url: string;
  readonly author_name: string;
  readonly author_username: string;
  readonly description: string;
  readonly diff_refs: DiffRefs | null;
  readonly project_id: number | null;
  readonly sha: string | null;
  readonly merge_commit_sha: string | null;
  readonly squash_commit_sha: string | null;
}

/** Изменённый файл MR: пути, флаги и полный текст диффа. */
export interface ChangedFile {
  readonly status: "A" | "D" | "R" | "M";
  readonly old_path: string;
  readonly new_path: string;
  readonly diff: string;
  readonly new_file: boolean;
  readonly renamed_file: boolean;
  readonly deleted_file: boolean;
  readonly additions: number;
  readonly deletions: number;
}

/** Позиция ноты в диффе; у общей ноты её нет. */
export interface NotePosition {
  readonly old_path: string | null;
  readonly new_path: string | null;
  readonly old_line: number | null;
  readonly new_line: number | null;
}

/** Нота треда в форме вывода `mr comments --json`. */
export interface Note {
  readonly id: number;
  readonly body: string;
  readonly author_name: string;
  readonly author_username: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly system: boolean;
  readonly resolvable: boolean;
  readonly resolved: boolean;
  readonly type: string | null;
  readonly position: NotePosition | null;
}

/** Тред ревью: ноты плюс сведённые по ним признаки. */
export interface Discussion {
  readonly id: string;
  readonly resolvable: boolean;
  readonly resolved: boolean;
  readonly position: NotePosition | null;
  readonly notes: readonly Note[];
}

/** Строка ключа; ключа нет, он не строка или пуст — `null`. */
function text(raw: RawObject, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Целое ключа; ключа нет или он не число — `null`. */
function integer(raw: RawObject, key: string): number | null {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Вложенный объект ключа; не объект или `null` — `undefined`. */
function object(raw: RawObject, key: string): RawObject | undefined {
  const value = raw[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RawObject
    : undefined;
}

/**
 * Три SHA диффа целиком либо ничего: частичного набора не бывает — у
 * MR без коммитов их нет вовсе, и «половина diff_refs» означала бы
 * инлайн-комментарий с недостающим якорем.
 */
export function diffRefsOf(raw: RawObject): DiffRefs | null {
  const refs = object(raw, "diff_refs");
  if (refs === undefined) return null;
  const base = text(refs, "base_sha");
  const start = text(refs, "start_sha");
  const head = text(refs, "head_sha");
  if (base === null || start === null || head === null) return null;
  return { base_sha: base, start_sha: start, head_sha: head };
}

/** Шапка MR; `project` приходит из адресации — API его не отдаёт. */
export function mergeRequestOf(raw: RawObject, project: string): MergeRequest {
  const author = object(raw, "author") ?? {};
  return {
    project,
    iid: integer(raw, "iid") ?? 0,
    title: text(raw, "title") ?? "",
    state: text(raw, "state") ?? "",
    source_branch: text(raw, "source_branch") ?? "",
    target_branch: text(raw, "target_branch") ?? "",
    web_url: text(raw, "web_url") ?? "",
    author_name: text(author, "name") ?? "",
    author_username: text(author, "username") ?? "",
    description: typeof raw.description === "string" ? raw.description : "",
    diff_refs: diffRefsOf(raw),
    project_id: integer(raw, "project_id"),
    sha: text(raw, "sha"),
    merge_commit_sha: text(raw, "merge_commit_sha"),
    squash_commit_sha: text(raw, "squash_commit_sha"),
  };
}

/**
 * Статус файла одной буквой, строго в порядке проверки спеки:
 * переименованный новый файл — это A, а не R.
 */
export function fileStatus(raw: RawObject): ChangedFile["status"] {
  if (raw.new_file === true) return "A";
  if (raw.deleted_file === true) return "D";
  if (raw.renamed_file === true) return "R";
  return "M";
}

/** Файл MR со счётчиками: они считаются из его же diff. */
export function changedFileOf(raw: RawObject): ChangedFile {
  const diff = typeof raw.diff === "string" ? raw.diff : "";
  const { additions, deletions } = countDiff(diff);
  return {
    status: fileStatus(raw),
    old_path: text(raw, "old_path") ?? "",
    new_path: text(raw, "new_path") ?? "",
    diff,
    new_file: raw.new_file === true,
    renamed_file: raw.renamed_file === true,
    deleted_file: raw.deleted_file === true,
    additions,
    deletions,
  };
}

/** Позиция ноты; ключа нет либо он не объект — `null`. */
export function positionOf(raw: RawObject): NotePosition | null {
  const position = object(raw, "position");
  if (position === undefined) return null;
  return {
    old_path: text(position, "old_path"),
    new_path: text(position, "new_path"),
    old_line: integer(position, "old_line"),
    new_line: integer(position, "new_line"),
  };
}

/** Нота как есть; `system` сохраняется, отбор — ниже. */
export function noteOf(raw: RawObject): Note {
  const author = object(raw, "author") ?? {};
  return {
    id: integer(raw, "id") ?? 0,
    body: typeof raw.body === "string" ? raw.body : "",
    author_name: text(author, "name") ?? "",
    author_username: text(author, "username") ?? "",
    created_at: text(raw, "created_at") ?? "",
    updated_at: text(raw, "updated_at") ?? "",
    system: raw.system === true,
    resolvable: raw.resolvable === true,
    resolved: raw.resolved === true,
    type: text(raw, "type"),
    position: positionOf(raw),
  };
}

/**
 * Треды из ответа `/discussions`: системные ноты отбрасываются на
 * входе, а тред из одних системных выпадает целиком — все потребители
 * (списки, матчинг, ответы, резолв) видят уже очищенные треды, и
 * второго места, где это можно забыть, нет.
 */
export function discussionsOf(raws: readonly RawObject[]): Discussion[] {
  const discussions: Discussion[] = [];
  for (const raw of raws) {
    const id = text(raw, "id");
    if (id === null) continue;
    const notes = (Array.isArray(raw.notes) ? raw.notes : [])
      .filter((note): note is RawObject =>
        typeof note === "object" && note !== null && !Array.isArray(note)
      )
      .map(noteOf)
      .filter((note) => !note.system);
    if (notes.length === 0) continue;
    const resolvable = notes.filter((note) => note.resolvable);
    discussions.push({
      id,
      // Тред resolvable, если resolvable хотя бы одна нота; resolved —
      // если такие ноты есть И все они resolved. У general-треда
      // resolvable-нот нет вовсе, поэтому оба признака ложны.
      resolvable: resolvable.length > 0,
      resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
      position: notes.find((note) => note.position !== null)?.position ?? null,
      notes,
    });
  }
  return discussions;
}
