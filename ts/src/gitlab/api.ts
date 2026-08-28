/**
 * Вызовы GitLab MR API по имени (`platform/gitlab-api.md`, таблица
 * эндпоинтов): шапка MR, изменённые файлы, треды.
 *
 * Слой тонкий намеренно: транспорт не знает, что такое MR, а модель не
 * знает, откуда пришёл объект. Здесь сходится только адресация — какой
 * путь у какого вызова и как ответ превращается в формы модели.
 */

import {
  asObject,
  asObjects,
  type GitlabAccess,
  GitlabError,
  gitlabGet,
  gitlabGetAll,
  gitlabSend,
  projectPath,
} from "./http.ts";
import {
  type ChangedFile,
  changedFileOf,
  type Discussion,
  discussionOf,
  discussionsOf,
  type MergeRequest,
  mergeRequestOf,
  type Note,
  noteOf,
} from "./model.ts";
import type { MrAddress } from "./resolve.ts";
import type { RawObject } from "./model.ts";

/** Префикс всех вызовов одного MR. */
function mrPath(address: MrAddress): string {
  return `/projects/${projectPath(address.project)}/merge_requests/` +
    `${address.iid}`;
}

/** Шапка MR: `project` берётся из адресации — API его не отдаёт. */
export async function mergeRequest(
  access: GitlabAccess,
  address: MrAddress,
): Promise<MergeRequest> {
  const path = mrPath(address);
  const body = await gitlabGet(access, path);
  return mergeRequestOf(asObject(body, path), address.project);
}

/**
 * Изменённые файлы с полным диффом. Только `/changes` и только с
 * `access_raw_diffs=true`: `/diffs` в крупных MR отдаёт часть файлов
 * свёрнутыми (`collapsed`, пустой `diff`), теряя и дифф, и привязку
 * комментария. Ответ приходит одним куском, без пагинации.
 */
export async function changedFiles(
  access: GitlabAccess,
  address: MrAddress,
): Promise<readonly ChangedFile[]> {
  const path = `${mrPath(address)}/changes`;
  const body = await gitlabGet(access, path, { access_raw_diffs: "true" });
  // `changes: []` — пустой MR, а вот отсутствие ключа означает, что
  // ответ не той формы (обрезан прокси, сменилось API): молчаливое
  // «изменённых файлов нет» здесь неотличимо от «ревьюить нечего».
  const changes = asObject(body, path).changes;
  return asObjects(changes, path).map(changedFileOf);
}

/** Треды MR: пагинировано, системные ноты отброшены моделью. */
export async function discussions(
  access: GitlabAccess,
  address: MrAddress,
): Promise<readonly Discussion[]> {
  const raw = await gitlabGetAll(access, `${mrPath(address)}/discussions`);
  return discussionsOf(raw);
}

/**
 * Новый тред MR. `form` несёт тело и — у инлайнового комментария —
 * скобочные ключи позиции; собирает их `position.ts`, а не этот вызов:
 * позиция строится по строке, найденной в диффе.
 */
export async function createDiscussion(
  access: GitlabAccess,
  address: MrAddress,
  form: Readonly<Record<string, string>>,
): Promise<Discussion> {
  const path = `${mrPath(address)}/discussions`;
  const body = await gitlabSend(access, "POST", path, form);
  const created = discussionOf(asObject(body, path));
  if (created === undefined) {
    // Ответ без нот означал бы, что тред не создан: успех с пустотой
    // здесь неотличим от промаха, ради которого и заведена спека.
    throw new GitlabError(`gitlab POST ${path}: ответ без нот дискуссии`, 0);
  }
  return created;
}

/** Ответ в существующий тред: нота, а не тред. */
export async function replyToDiscussion(
  access: GitlabAccess,
  address: MrAddress,
  discussionId: string,
  body: string,
): Promise<Note> {
  const path = `${mrPath(address)}/discussions/${discussionId}/notes`;
  const answer = await gitlabSend(access, "POST", path, { body });
  return noteOf(asObject(answer, path));
}

/** Замена тела ноты; чужую ноту отобьёт сам GitLab (403). */
export async function updateNote(
  access: GitlabAccess,
  address: MrAddress,
  noteId: number,
  body: string,
): Promise<Note> {
  const path = `${mrPath(address)}/notes/${noteId}`;
  const answer = await gitlabSend(access, "PUT", path, { body });
  return noteOf(asObject(answer, path));
}

/** Удаление ноты; тело ответа пустое. */
export async function deleteNote(
  access: GitlabAccess,
  address: MrAddress,
  noteId: number,
): Promise<void> {
  await gitlabSend(access, "DELETE", `${mrPath(address)}/notes/${noteId}`);
}

/** Резолв треда: признак идёт query-параметром, а не телом (атом). */
export async function setDiscussionResolved(
  access: GitlabAccess,
  address: MrAddress,
  discussionId: string,
  resolved: boolean,
): Promise<void> {
  await gitlabSend(
    access,
    "PUT",
    `${mrPath(address)}/discussions/${discussionId}`,
    {},
    { resolved: String(resolved) },
  );
}

/** Замена описания MR целиком; ответ — сам MR. */
export async function updateDescription(
  access: GitlabAccess,
  address: MrAddress,
  description: string,
): Promise<MergeRequest> {
  const path = `/projects/${projectPath(address.project)}/merge_requests/` +
    `${address.iid}`;
  const body = await gitlabSend(access, "PUT", path, { description });
  return mergeRequestOf(asObject(body, path), address.project);
}

/** Создание MR; пустое описание не отправляется вовсе (спека). */
export async function createMergeRequest(
  access: GitlabAccess,
  project: string,
  fields: {
    readonly source_branch: string;
    readonly target_branch: string;
    readonly title: string;
    readonly description: string;
  },
): Promise<MergeRequest> {
  const path = `/projects/${projectPath(project)}/merge_requests`;
  const form: Record<string, string> = {
    source_branch: fields.source_branch,
    target_branch: fields.target_branch,
    title: fields.title,
  };
  if (fields.description !== "") form.description = fields.description;
  const body = await gitlabSend(access, "POST", path, form);
  return mergeRequestOf(asObject(body, path), project);
}

/**
 * Ветки, содержащие коммит: GET
 * `…/repository/commits/{sha}/refs?type=branch` (`glab-status.md`).
 *
 * 404 означает «коммита на хосте нет» — например, после переписывания
 * истории. Это НЕ пустой список веток: пустой список говорит «коммит
 * есть, но ни в одной ветке», а тут данных нет вовсе, и путать их
 * нельзя (отклонение `fix` спеки). Отсюда `undefined` вместо `[]`.
 */
export async function commitBranches(
  access: GitlabAccess,
  projectId: number,
  sha: string,
): Promise<readonly string[] | undefined> {
  const path = `/projects/${projectId}/repository/commits/` +
    `${encodeURIComponent(sha)}/refs`;
  try {
    const raw = await gitlabGetAll(access, path, { type: "branch" });
    return raw
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((name) => name !== "");
  } catch (err) {
    if (err instanceof GitlabError && err.status === 404) return undefined;
    throw err;
  }
}

/**
 * Мои MR за окно: глобальный эндпоинт `/merge_requests`. Проекта он не
 * отдаёт — его восстанавливает вызывающий из `web_url`
 * (`glab-status.md`, «Режим мои MR»).
 */
export async function myMergeRequests(
  access: GitlabAccess,
  updatedAfter: string,
): Promise<readonly RawObject[]> {
  return await gitlabGetAll(access, "/merge_requests", {
    scope: "created_by_me",
    updated_after: updatedAfter,
    order_by: "created_at",
    sort: "asc",
  });
}
