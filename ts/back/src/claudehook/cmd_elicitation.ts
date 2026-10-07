/**
 * Команда `mpu claude-hook elicitation` в дереве
 * (`claude-hook-elicitation.md`, «CLI-контракт»): справка, место в дереве
 * и посев. Исполняет строку ядро — у него вопросы владельцу
 * (`line/hook.ts`, `elicitation_desk.ts`); до исполнителя из пула строка не
 * доходит.
 */

import { z } from "zod";
import { defineCommand } from "../command/mod.ts";
import { ELICITATION } from "../frames/mod.ts";
import { DEADLINE_MS, HOOK_TIMEOUT_S } from "./desk.ts";

const argsSchema = z.object({});

const resultSchema = z.object({});

/**
 * Запись хука в `~/.claude/settings.json` (голден
 * `settings-fragment-elicitation.json`).
 */
const FRAGMENT = `{"hooks":{"Elicitation":[{"matcher":"",
  "hooks":[{"type":"command","command":"mpu claude-hook elicitation",
  "timeout":${HOOK_TIMEOUT_S}}]}]}}`;

export const claudeHookElicitationCommand = defineCommand({
  path: ELICITATION.words,
  keys: {},
  errorName: "claude-hook elicitation",
  summary: "Как ответить на форму MCP-сервера из Telegram?",
  usage: "mpu claude-hook elicitation",
  help: `Звать не руками: её зовёт Claude Code хуком Elicitation перед
показом формы MCP-сервера; пока хук работает, форма в терминале закрыта.
Форма уходит в чат TELEGRAM_BOT_ID: заголовок — 📝, сервер, название
сессии, проект, окно tmux; по шагу на поле. На каждом шаге — Decline и
В терминале (форма уходит в терминал); необязательное поле — Пропустить.
Форма самого mpu не задаётся: её вопрос уже в чате. Форма-ссылка (url) —
уведомление без кнопок.

Вход — stdin, JSON-объект payload'а хука; аргументов нет.

  ответ из чата — stdout {"hookSpecificOutput":{"hookEventName":
    "Elicitation","action":"accept","content":{…}}} или "action":"decline"
  без решения — stdout пуст, в stderr одна строка
    mpu claude-hook elicitation: без решения — <причина>
    (ответ в терминале, форма mpu — вопрос уже в чате, режим url — ответ
    по ссылке, истёк срок ожидания, бот не настроен, бот недоступен: …,
    сервер mpu не отвечает: …, вход не разобран: …)

Ждёт до ${DEADLINE_MS / 1000} с, места исполнителей строк не занимает.
Exit: всегда 0.

Включение — ставит install.sh, в ~/.claude/settings.json:
${FRAGMENT}`,
  examples: ["mpu claude-hook elicitation < payload.json"],
  policy: "rw",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error(
        "строку claude-hook elicitation исполняет ядро, не исполнитель",
      ),
    ),
  render: () => "",
});
