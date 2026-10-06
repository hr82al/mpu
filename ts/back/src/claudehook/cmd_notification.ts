/**
 * Команда `mpu claude-hook notification` в дереве
 * (`docs/specs/claude-hook-notification.md`,
 * `docs/specs/claude-hook-notification-snapshot.md`): справка, место и
 * посев. Исполняет строку ядро (`notify_desk.ts`): решению «есть ли у
 * сессии вопрос в ряду» и снимку окна нужен его ряд вопросов.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { NOTIFICATION } from "../frames/mod.ts";

const argsSchema = z.object({});

const resultSchema = z.object({});

export const claudeHookNotificationCommand = defineCommand({
  path: NOTIFICATION.words,
  keys: {},
  errorName: "claude-hook notification",
  summary: "Отправить уведомление хука Claude Code в личного бота.",
  usage: "mpu claude-hook notification",
  help: `Звать не руками: команду вызывает хук Notification Claude Code.
Вход — stdin, JSON-объект payload'а события; аргументов нет.

Ожидание (notification_type оканчивается на _prompt или _dialog) из окна
tmux: через 3 с, если у сессии нет вопроса в ряду (право,
AskUserQuestion, «ждёт ввода»), — вопрос-снимок окна в чате: блок
диалога с экрана, кнопки-пункты, ⏎ ⎋ ↑ ↓ и «весь экран»; кнопка нажимает
клавишу в окне, текст владельца вписывается и Enter. Хук выходит сразу.

Прочее (не ожидание или окна нет) — строка в бота:

  Claude · <проект> · <notification_type>
  <message, иначе notification_message>

stdout — одна строка JSON {"id": …}; отказ — строка в stderr
(mpu claude-hook notification: <причина>). Exit: 0 — строка ушла или
ожидание отложено до решения о снимке; 1 — бот не настроен или
недоступен; 2 — stdin не JSON-объект.

Включение — ставит install.sh, в ~/.claude/settings.json:
{"hooks":{"Notification":[{"matcher":"","hooks":[{"type":"command",
  "command":"mpu claude-hook notification","timeout":30}]}]}}`,
  examples: ["mpu claude-hook notification < payload.json"],
  policy: "rw",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error(
        "строку claude-hook notification исполняет ядро, не исполнитель",
      ),
    ),
  render: () => "",
});
