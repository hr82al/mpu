/**
 * Адаптеры хуков Claude Code (`docs/specs/claude-hook-notification.md`,
 * `docs/specs/claude-hook-pre-tool-use.md`,
 * `docs/specs/claude-hook-permission-request.md`,
 * `docs/specs/claude-hook-stop.md`,
 * `docs/specs/claude-hook-elicitation.md`) и канал Claude Code
 * (`docs/specs/claude-channel.md`): событие приходит JSON-объектом на
 * stdin.
 *
 * `notification` — команда реестра целиком: разбор конверта и сборка
 * текста остаются внутренностями. `pre-tool-use` и `permission-request`
 * исполняет ядро строк потребителя, поэтому наружу отданы разбор
 * payload'а (`toolCallOf`), стол вопроса владельцу (`PermissionDesk`) и
 * ответы хуков с причинами. `stop` — тоже ядро: стол вопросов «ждёт
 * ввода» (`StopDesk`) держит их дольше строки хука. `elicitation` — ядро:
 * форма MCP-сервера владельцу (`ElicitationDesk`). Уведомления —
 * `NotifyDesk`.
 *
 * Сервер потребителя держит на весь процесс сеансы Claude Code
 * (`Sessions`, ключ — `sessionKeyOf`) и их каналы (`WireLink`), окна tmux
 * (`Windows`) и транскрипты (`Transcripts`): пакет отдаёт устройство,
 * экземпляры и их время жизни — у потребителя. У каждого стола есть
 * стол без бота (`NO_DESK`, `NO_STOP_DESK`, `NO_NOTIFY_DESK`,
 * `NO_ELICITATION_DESK`: отказ «бот не настроен»), у окон — `NO_WINDOWS`
 * (подписи не бывает).
 */

export { claudeHookNotificationCommand } from "./src/cmd_notification.ts";
export { claudeHookPreToolUseCommand } from "./src/cmd_pre_tool_use.ts";
export { claudeHookPermissionRequestCommand } from "./src/cmd_permission_request.ts";
export { claudeHookStopCommand } from "./src/cmd_stop.ts";
export { claudeChannelCommand } from "./src/cmd_claude_channel.ts";
export { claudeHookElicitationCommand } from "./src/cmd_elicitation.ts";
export { type DeskParts, NO_DESK, PermissionDesk } from "./src/desk.ts";
export { type ChannelWire, WireLink } from "./src/channel.ts";
export { type Session, sessionKeyOf, Sessions } from "./src/sessions.ts";
export { NO_NOTIFY_DESK, NotifyDesk } from "./src/notify_desk.ts";
export { NO_STOP_DESK, StopDesk, type StopDeskParts } from "./src/stop_desk.ts";
export {
  ElicitationDesk,
  type ElicitationParts,
  NO_ELICITATION_DESK,
} from "./src/elicitation_desk.ts";
export {
  DISK_FILES,
  type TranscriptFiles,
  Transcripts,
} from "./src/transcript.ts";
export {
  type CallerEnv,
  NO_WINDOWS,
  RUN_TMUX,
  type TmuxRun,
  Windows,
} from "./src/window.ts";
export { toolCallOf } from "./src/call.ts";
export { TERMINAL } from "./src/decision.ts";
export {
  Allowed,
  askedBy,
  atExecution,
  Denied,
  type HookReply,
  HUMAN_DECIDES,
  NOT_RULED,
  RULE_CHANGE,
  Undecided,
  unparsedLine,
} from "./src/reply.ts";
