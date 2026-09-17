/**
 * Команда `mpu claude-hook notification`
 * (`docs/specs/claude-hook-notification.md`): уведомление из хука
 * Claude Code уходит в личного бота.
 *
 * Здесь только склейка: разбор payload'а и текст — `payload.ts`,
 * конфигурация и отправка — модуль `telegram`. Своей копии правил Bot
 * API у команды нет.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  readTextStdin,
} from "../command/mod.ts";
import { botConfig, sendBotMessage } from "../telegram/mod.ts";
import { notificationText, parseHookPayload } from "./payload.ts";

const argsSchema = z.object({});

const resultSchema = z.object({
  id: z.number().describe("номер отправленного сообщения"),
});

type NotificationResult = z.infer<typeof resultSchema>;

/** Срез порта: весь вход команды — stdin, вся настройка — env-файл. */
type NotificationIo = Pick<CommandIo, "readStdin" | "envFile">;

/**
 * Разбор stdin, текст и одна отправка. `apiBase` пробрасывается как
 * есть: не задан — работает умолчание `sendBotMessage`, задан — тест
 * отправки ходит на петлевой сервер, а не наружу.
 *
 * Порядок фиксирован: разбор ввода раньше конфигурации, а обе — раньше
 * сети.
 */
export async function runNotification(
  io: NotificationIo,
  apiBase?: string,
): Promise<NotificationResult> {
  const payload = parseHookPayload(await readTextStdin(io));
  const text = notificationText(payload);
  const sent = await sendBotMessage(
    botConfig(io.envFile),
    { kind: "text", text },
    apiBase,
  );
  return { id: sent.id };
}

export const claudeHookNotificationCommand = defineCommand({
  path: ["claude-hook", "notification"],
  errorName: "claude-hook notification",
  summary: "Отправить уведомление хука Claude Code в личного бота.",
  usage: "mpu claude-hook notification",
  help: `Адаптер хука Notification: весь stdin — JSON-объект payload'а
события, наружу уходит одно сообщение личному боту (тот же канал, что
у mpu telegram log). Аргументов и опций нет.

Сообщение — две строки, вторая только при непустом тексте события:

  Claude · <проект> · <notification_type>
  <message, иначе notification_message>

<проект> — базовое имя каталога cwd; нет cwd — часть опускается. Нет
типа — слово notification. Текст события живой хук кладёт в message,
дока Claude Code называет то же поле notification_message — читаются
оба, первым message. Текст длиннее 4096 символов усекается, а не
отбивается: отказ здесь не видит никто.

Типы событий команда не фильтрует — отбор делает matcher в настройке
хука, второго места отбора быть не должно. Незнакомый тип доезжает.

CLI-only: тулом MCP-сервера команда не публикуется (закрытый список
публикации её не содержит) — у вызова тула stdin нет по построению, а
вне хука команда бессмысленна.

stdout — одна строка JSON: {"id": …}. Claude вывод и код выхода хука
игнорирует; отказ виден в журнале вызовов: mpu log --failed --since 1h.

Ключи env-файла: TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_ID (обязательны),
TELEGRAM_BOT_NAME (необязателен). Прокси — как у mpu telegram log.

Exit: 0 — успех; 1 — конфигурация или отказ Bot API; 2 — stdin не
разбирается как JSON-объект.

Включение — в ~/.claude/settings.json, секция hooks.Notification:
{"type": "command", "command": "mpu claude-hook notification"}`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: (_args, io) => runNotification(io),
  render: (result: NotificationResult) => `{"id": ${result.id}}\n`,
});
