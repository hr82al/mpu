/**
 * Адаптеры хуков Claude Code (`docs/specs/claude-hook-notification.md`,
 * `docs/specs/claude-hook-pre-tool-use.md`): событие приходит
 * JSON-объектом на stdin.
 *
 * `notification` — команда реестра целиком: разбор конверта и сборка
 * текста остаются внутренностями. `pre-tool-use` исполняет ядро
 * (`line/hook.ts`), поэтому наружу отданы разбор payload'а
 * (`toolCallOf`) и ответы хука с причинами. Следующий хук
 * Claude Code (`Stop`, `SessionEnd`) — соседний файл рядом, без
 * переукладки.
 */

export { claudeHookNotificationCommand } from "./cmd_notification.ts";
export { claudeHookPreToolUseCommand } from "./cmd_pre_tool_use.ts";
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
