/**
 * Команда `mpu claude-hook permission-request` в дереве
 * (`claude-hook-permission-request.md`, «CLI-контракт»): справка, место в
 * дереве и посев. Исполняет строку ядро — у него вопросы владельцу
 * (`line/hook.ts`, `desk.ts`); до исполнителя из пула строка не доходит.
 */

import { z } from "zod";
import { defineCommand } from "../command/mod.ts";
import { PERMISSION_REQUEST } from "../frames/mod.ts";
import { DEADLINE_MS, HOOK_TIMEOUT_S } from "./desk.ts";

const argsSchema = z.object({});

const resultSchema = z.object({});

/** Запись хука в `~/.claude/settings.json` (голден `settings-fragment.json`). */
const FRAGMENT = `{"hooks":{"PermissionRequest":[{"matcher":"",
  "hooks":[{"type":"command",
  "command":"mpu claude-hook permission-request",
  "timeout":${HOOK_TIMEOUT_S}}]}]}}`;

export const claudeHookPermissionRequestCommand = defineCommand({
  path: PERMISSION_REQUEST.words,
  keys: {},
  errorName: "claude-hook permission-request",
  summary: "Как ответить на вопрос Claude Code о праве из Telegram?",
  usage: "mpu claude-hook permission-request",
  help: `Звать не руками: её зовёт Claude Code хуком PermissionRequest
перед каждым вопросом о праве и перед каждым AskUserQuestion. Терминальный
диалог при этом открыт: решает первый ответ — кнопкой или текстом
владельца в его чате с ботом, либо в терминале.

Вход — stdin, JSON-объект payload'а хука; аргументов нет. Вопрос уходит
в чат TELEGRAM_BOT_ID с вариантами терминала; заголовок — инструмент,
название сессии, проект, окно tmux.

  ответ из чата — stdout {"hookSpecificOutput":{"hookEventName":
    "PermissionRequest","decision":{"behavior":"allow"|"deny",…}}}
  без решения — stdout пуст, в stderr одна строка
    mpu claude-hook permission-request: без решения — <причина>
    (решено в терминале, истёк срок ожидания, бот не настроен,
    бот недоступен: …, сервер mpu не отвечает: …, вход не разобран: …)

Ждёт до ${DEADLINE_MS / 1000} с, места исполнителей строк не занимает.
Exit: всегда 0.

Включение — ставит install.sh, в ~/.claude/settings.json:
${FRAGMENT}`,
  examples: ["mpu claude-hook permission-request < payload.json"],
  policy: "rw",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error(
        "строку claude-hook permission-request исполняет ядро, не исполнитель",
      ),
    ),
  render: () => "",
});
