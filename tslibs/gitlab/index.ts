/**
 * `@mpu/gitlab` — клиент GitLab MR API без привязки к рантайму и к слою
 * команд (`ts/docs/specs/platform/tslibs-n1.md`, поведение —
 * `platform/gitlab-api.md`): доступ, резолв адреса MR, вызовы REST API v4 и
 * формы ответов, запуск локального git для резолва (`spawnGit`).
 *
 * Наружу отдаётся ровно то, чем пользуются команды семейства `mr` и
 * `glab-status`. Разбор unified diff наружу не выведен: с ним работают только
 * счётчики файлов и построение позиции — оба внутри пакета, и командам
 * достаётся результат (`findLine`, `positionForm`), а не сам разбор.
 *
 * Отказы — свои классы (`GitlabError`, `MrRefError`, `DiscussionRefError`);
 * в ошибки команды их переводит потребитель. Фейковый GitLab для тестов —
 * `@mpu/gitlab/testing`. Описание каждого имени — JSDoc у его определения.
 */

export { DiscussionRefError, matchDiscussion } from "./src/discussion.ts";
export {
  DEFAULT_BASE_URL,
  type GitlabAccess,
  GitlabError,
} from "./src/http.ts";
export {
  type ChangedFile,
  type Discussion,
  type MergeRequest,
  mergeRequestOf,
  type NotePosition,
  type RawObject,
} from "./src/model.ts";
export {
  type GitOutcome,
  type MrAddress,
  MrRefError,
  parseMrRef,
  projectFromRemote,
  type ResolveContext,
  resolveMr,
  type RunGit,
} from "./src/resolve.ts";
export {
  changedFiles,
  commitBranches,
  createDiscussion,
  createMergeRequest,
  deleteNote,
  discussions,
  mergeRequest,
  myMergeRequests,
  replyToDiscussion,
  setDiscussionResolved,
  updateDescription,
  updateNote,
} from "./src/api.ts";
export {
  commentableLines,
  type DiffSide,
  findLine,
  positionForm,
  rangesText,
} from "./src/position.ts";
export { spawnGit } from "./src/git.ts";
