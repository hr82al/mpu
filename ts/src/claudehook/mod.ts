/**
 * Адаптеры хуков Claude Code (`docs/specs/claude-hook-notification.md`):
 * событие приходит JSON-объектом на stdin, а наружу уходит уведомление
 * в личного бота.
 *
 * Наружу модуль отдаёт только команды реестра; разбор конверта и сборка
 * текста остаются внутренностями. Следующий хук Claude Code (`Stop`,
 * `SessionEnd`) — соседний файл рядом, без переукладки.
 */

export { claudeHookNotificationCommand } from "./cmd_notification.ts";
