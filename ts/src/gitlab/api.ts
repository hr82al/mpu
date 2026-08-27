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
  gitlabGet,
  gitlabGetAll,
  projectPath,
} from "./http.ts";
import {
  type ChangedFile,
  changedFileOf,
  type Discussion,
  discussionsOf,
  type MergeRequest,
  mergeRequestOf,
} from "./model.ts";
import type { MrAddress } from "./resolve.ts";

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
