/**
 * Клиент GitLab MR API (`docs/specs/platform/gitlab-api.md`): доступ,
 * резолв адреса MR, вызовы REST API v4 и формы ответов.
 *
 * Наружу отдаётся ровно то, чем пользуются команды семейства `mr`.
 * Разбор unified diff наружу не выведен: его единственный потребитель
 * — счётчики файлов внутри самого модуля, а адресация инлайн-строк
 * появится вместе с write-подкомандами.
 */

export {
  countDiff,
  type DiffCounts,
  type DiffLine,
  type DiffLineKind,
  parseDiffLines,
} from "./diff.ts";
export { DiscussionRefError, matchDiscussion } from "./discussion.ts";
export { DEFAULT_BASE_URL, type GitlabAccess, GitlabError } from "./http.ts";
export {
  type ChangedFile,
  type Discussion,
  type NotePosition,
} from "./model.ts";
export {
  type GitOutcome,
  type MrAddress,
  MrRefError,
  type ResolveContext,
  resolveMr,
  type RunGit,
} from "./resolve.ts";
export { changedFiles, discussions, mergeRequest } from "./api.ts";
