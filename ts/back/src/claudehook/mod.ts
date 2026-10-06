/**
 * Адаптеры хуков Claude Code (`docs/specs/claude-hook-notification.md`,
 * `docs/specs/claude-hook-pre-tool-use.md`,
 * `docs/specs/claude-hook-permission-request.md`): событие приходит
 * JSON-объектом на stdin.
 *
 * `notification` — команда реестра целиком: разбор конверта и сборка
 * текста остаются внутренностями. `pre-tool-use` и `permission-request`
 * исполняет ядро (`line/hook.ts`), поэтому наружу отданы разбор
 * payload'а (`toolCallOf`), стол вопроса владельцу (`PermissionDesk`) и
 * ответы хуков с причинами. Следующий хук Claude Code (`Stop`,
 * `SessionEnd`) — соседний файл рядом, без переукладки.
 */

export { claudeHookNotificationCommand } from "./cmd_notification.ts";
export { claudeHookPreToolUseCommand } from "./cmd_pre_tool_use.ts";
export { claudeHookPermissionRequestCommand } from "./cmd_permission_request.ts";
export {
  DEADLINE_MS,
  type DeskParts,
  HOOK_TIMEOUT_S,
  NO_DESK,
  PermissionDesk,
} from "./desk.ts";
export {
  DISK_FILES,
  type TranscriptFiles,
  Transcripts,
  WATCH_MS,
} from "./transcript.ts";
export {
  type CallerEnv,
  NO_WINDOWS,
  RUN_TMUX,
  type TmuxRun,
  Windows,
} from "./window.ts";
export { toolCallOf } from "./call.ts";
export {
  Allowed,
  askedBy,
  atExecution,
  Denied,
  type HookReply,
  HUMAN_DECIDES,
  NOT_RULED,
  programUnseen,
  RULE_CHANGE,
  Undecided,
  unparsedLine,
} from "./reply.ts";
