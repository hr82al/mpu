/**
 * Клиент GitLab MR API (`docs/specs/platform/gitlab-api.md`): доступ,
 * резолв адреса MR, вызовы REST API v4 и формы ответов.
 *
 * Наружу отдаётся ровно то, чем пользуются команды семейства `mr`.
 * Разбор unified diff наружу не выведен: с ним работают только
 * счётчики файлов и построение позиции — оба внутри модуля, и командам
 * достаётся результат (`findLine`, `positionForm`), а не сам разбор.
 */

export { DiscussionRefError, matchDiscussion } from "./discussion.ts";
export { DEFAULT_BASE_URL, type GitlabAccess, GitlabError } from "./http.ts";
export {
  type ChangedFile,
  type Discussion,
  type MergeRequest,
  mergeRequestOf,
  type NotePosition,
  type RawObject,
} from "./model.ts";
export {
  type GitOutcome,
  type MrAddress,
  MrRefError,
  parseMrRef,
  projectFromRemote,
  type ResolveContext,
  resolveMr,
  type RunGit,
} from "./resolve.ts";
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
} from "./api.ts";
export {
  commentableLines,
  type DiffSide,
  findLine,
  positionForm,
  rangesText,
} from "./position.ts";
