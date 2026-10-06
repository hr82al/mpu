/**
 * Команда `mpu claude-hook stop` в дереве (`claude-hook-stop.md`,
 * «CLI-контракт»): справка, место в дереве и посев. Исполняет строку ядро
 * — у него вопросы владельцу (`line/hook.ts`, `stop_desk.ts`); до
 * исполнителя из пула строка не доходит.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { STOP } from "../frames/mod.ts";

const argsSchema = z.object({});

const resultSchema = z.object({});

/**
 * Срок хука во фрагменте настроек, секунды: хук не ждёт владельца, срок —
 * только на постановку.
 */
const STOP_TIMEOUT_S = 30;

/** Запись хука в `~/.claude/settings.json` (голден `settings-fragment-stop.json`). */
const FRAGMENT = `{"hooks":{"Stop":[{"matcher":"",
  "hooks":[{"type":"command","command":"mpu claude-hook stop",
  "timeout":${STOP_TIMEOUT_S}}]}]}}`;

export const claudeHookStopCommand = defineCommand({
  path: STOP.words,
  keys: {},
  errorName: "claude-hook stop",
  summary:
    "Как сообщить владельцу в Telegram, что сессия Claude Code ждёт ввода?",
  usage: "mpu claude-hook stop",
  help: `Звать не руками: её зовёт Claude Code хуком Stop в конце каждого
хода. В чат TELEGRAM_BOT_ID уходит сообщение «ждёт ввода»: заголовок —
💬, название сессии, проект, окно tmux; тело — последнее сообщение
сессии (длинное — его конец). Хук выходит сразу, ответа не ждёт.

Вход — stdin, JSON-объект payload'а хука; аргументов нет.

  stdout пуст всегда
  не поставлено — в stderr одна строка
    mpu claude-hook stop: без вопроса — <причина>
    (продолжение хода, бот не настроен, бот недоступен: …,
    сервер mpu не отвечает: …, вход не разобран: …)

Сообщение снимается само: в сессии набран ввод (✅ решено в
терминале) или она снова закончила ход. Кнопка Пропустить снимает его
из чата. Вопросы о праве и AskUserQuestion идут раньше. Ответ текстом
из чата доходит в сессию с каналом mpu (запущена алиасом claude, кнопки
Позже · Пропустить); сессии без канала — ответьте в терминале.
Exit: всегда 0.

Включение — ставит install.sh, в ~/.claude/settings.json:
${FRAGMENT}`,
  examples: ["mpu claude-hook stop < payload.json"],
  policy: "rw",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error("строку claude-hook stop исполняет ядро, не исполнитель"),
    ),
  render: () => "",
});
