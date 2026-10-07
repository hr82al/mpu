/**
 * Команда `mpu claude-channel` в дереве (`claude-channel.md`,
 * «CLI-контракт»): справка и место. Исполняет её клиент (`cli/`) — он
 * держит stdio Claude Code; строкой ядра она не исполняется.
 */

import { z } from "zod";
import { defineCommand } from "../command/mod.ts";

const argsSchema = z.object({});

const resultSchema = z.object({});

export const claudeChannelCommand = defineCommand({
  path: ["claude-channel"],
  keys: {},
  errorName: "claude-channel",
  summary:
    "Как доставить ответ владельца из Telegram прямо в сессию Claude Code?",
  usage: "mpu claude-channel",
  help: `Звать не руками: её запускает Claude Code дочерним процессом
сессии, начатой с флагом development-канала server:mpu-channel (алиас
claude ставит install.sh). Канал — stdio-сервер MCP: объявляет
claude/channel, тулов не публикует.

Регистрируется в ядре mpu ключом сессии CLAUDE_CODE_MESSAGING_SOCKET;
ядро недоступно — повтор каждые 5 с. Текст владельца на «ждёт ввода»
этой сессии приходит в неё уведомлением notifications/claude/channel,
в чате — «✅ <текст> — из чата». Канал закрылся — «⌛ сессия закрыта».

Exit: 0 — stdin закрыт (сессия кончилась); 1 — нет
CLAUDE_CODE_MESSAGING_SOCKET (запущена не Claude Code).`,
  examples: ["mpu claude-channel"],
  policy: "ro",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error("claude-channel исполняет клиент mpu, не ядро"),
    ),
  render: () => "",
});
