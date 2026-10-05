/**
 * Адаптеры хуков Claude Code (`docs/specs/claude-hook-notification.md`,
 * `docs/specs/claude-hook-pre-tool-use.md`): событие приходит
 * JSON-объектом на stdin.
 *
 * `notification` — команда реестра целиком: разбор конверта и сборка
 * текста остаются внутренностями. `pre-tool-use` исполняет ядро
 * (`line/hook.ts`), поэтому наружу отданы и граница её ввода — вызов
 * инструмента из payload'а, — и ответ хука с причинами. Следующий хук
 * Claude Code (`Stop`, `SessionEnd`) — соседний файл рядом, без
 * переукладки.
 */

export { claudeHookNotificationCommand } from "./cmd_notification.ts";
export { claudeHookPreToolUseCommand } from "./cmd_pre_tool_use.ts";
export { BashCall, McpCall, NotMpu, toolCallOf, Unparsed } from "./call.ts";
export type { Consult, ToolCall } from "./tool.ts";
export {
  Allowed,
  askedBy,
  atExecution,
  Denied,
  type HookReply,
  type HookSpeech,
  HUMAN_DECIDES,
  NOT_MPU,
  NOT_RULED,
  programUnseen,
  RULE_CHANGE,
  Undecided,
  unparsedInput,
  unparsedLine,
} from "./reply.ts";
