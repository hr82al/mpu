/**
 * Команда `mpu claude-hook pre-tool-use` в дереве
 * (`claude-hook-pre-tool-use.md`, «CLI-контракт»): справка, место в
 * дереве и посев. Исполняет строку ядро — у него правила, дверь и образ
 * (`line/hook.ts`); до исполнителя из пула строка не доходит.
 */

import { z } from "zod";
import { defineCommand } from "@mpu/command";
import { PRE_TOOL_USE } from "@mpu/language/frames";

const argsSchema = z.object({});

const resultSchema = z.object({});

export const claudeHookPreToolUseCommand = defineCommand({
  path: PRE_TOOL_USE.words,
  keys: {},
  errorName: "claude-hook pre-tool-use",
  summary: "Какое решение правил mpu у вызова инструмента Claude Code?",
  usage: "mpu claude-hook pre-tool-use",
  help: `Звать не руками: её зовёт Claude Code хуком PreToolUse на Bash \
mpu … и на mcp__mpu__mpu. В отличие от правил permissions настроек \
Claude Code правила живут в одном месте, у mpu, и решают по пути \
строки, а не по началу её текста.

Вход — stdin, JSON-объект payload'а хука; аргументов нет. Решение
выносится, только когда исполнится ровно одна простая строка mpu с
литеральными словами (Bash) или слова тула (MCP):

  allow — stdout {"hookSpecificOutput":{…"permissionDecision":"allow"…}}
  deny  — stdout то же с "deny"
  без решения — stdout пуст, в stderr одна строка
    mpu claude-hook pre-tool-use: без решения — <причина>
    (правило ask, подстановка или оператор оболочки, программа, не
    вызов mpu, правила недоступны …); Claude Code проверяет вызов сам.

Ничего не исполняет из строки, не спрашивает человека, не пишет ни в
правила, ни в журнал вызовов. Exit: всегда 0.

Включение — после установки версии с этой командой, в
~/.claude/settings.json:
{"hooks":{"PreToolUse":[{"matcher":"Bash|mcp__mpu__mpu",
  "hooks":[{"type":"command","command":"mpu claude-hook pre-tool-use",
  "timeout":10}]}]}}`,
  examples: ["mpu claude-hook pre-tool-use < payload.json"],
  policy: "ro",
  argsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error(
        "строку claude-hook pre-tool-use исполняет ядро, не исполнитель",
      ),
    ),
  render: () => "",
});
