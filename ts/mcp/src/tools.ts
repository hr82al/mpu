/**
 * Два тула переводчика (`platform/mcp-objects.md`, «Тулы»): `help` и
 * `mpu`. Оба — одна операция: строка `mpu-back` до `exit`, с ответами
 * человека на вопросы. О командах тулы не знают: справку и исполнение даёт
 * `back`.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GRAMMAR } from "../../back/src/messages/mod.ts";
import type { Asker } from "./asker.ts";
import type { BackLine } from "./back.ts";

/**
 * Описание тула `mpu` (`fixtures/mcp-objects/tool-desc-v3.txt`): слова
 * грамматики подставлены из константы разбора (`platform/line-grammar.md`
 * [D.1]) — их написание живёт в одном месте.
 */
const { open, close, literal } = GRAMMAR;
const MPU_DESCRIPTION =
  `mpu — строка сообщений объектам mpu-back. Вход — массив слов \`words\`.

Грамматика как в Smalltalk:
- Унарное — голое слово: \`kiten ls\`, \`help\`. Ключевое — \`ключ: значение\` или \`--ключ значение\`; ключи подряд — одно сообщение.
- Значение — только ключом; голое слово — всегда сообщение. Одно слово массива — одно значение, пробелы внутри можно: \`sql: "select 1"\`. Кавычки литерала не делают (\`"${close}"\` — то же слово ${close}); слова грамматики как значение — через \`${literal}\`: \`text: ${literal} ${close}\`.
- Порядок: команда → варианты (\`dry\`, \`all\`, \`local\`, \`portainer\`) → ключи. Вариант после ключа — ошибка.
- Приоритет: унарное выше ключевого. Формат результата — слово после \`${close}\`; \`${close}\` закрывает группу от начала строки: \`kiten card id: 123 ${close} md\`, \`kiten ls ${close} csv\`. Внутри строки группу открывает \`${open}\`.
- Форматы: \`json\`, \`md\`, \`csv\`, \`table\`.
- Ключи везде одни: \`target:\` где исполнить (номер клиента, имя или часть, \`sl-N\`, \`dev:N\`), \`id:\` номер сущности, \`text:\` текст, \`query:\` что искать, \`since:\`/\`until:\` время (\`1h\`, \`2026-09-01\`), \`limit:\` сколько.
- Справка — \`help\` последним словом объекту: \`help\`, \`kiten card help\`; \`--help\` — то же.
- Строки с записью или отправкой требуют подтверждения человека и начинаются словом \`ask\`: \`ask sql target: sl-1 sql: "…"\`. Список — \`ask help\`.`;

const HELP_DESCRIPTION =
  `Справка mpu: какие команды есть и как их писать. Звать перед тулом mpu, \
когда команда или её аргументы не известны.

path — путь до узла дерева команд: [] или без path — справка корня (список команд верхнего уровня), \
["kiten"] — группа, ["kiten", "card"] — команда. Справка никогда не исполняет команду.`;

/** Тулы переводчика — данные: они же ответ `tools/list` (голден). */
export const TOOLS = [
  {
    name: "help",
    description: HELP_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "array",
          items: { type: "string" },
          description: "путь до узла дерева команд; по умолчанию — корень",
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "mpu",
    description: MPU_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "слова строки, как в оболочке после «mpu»",
        },
      },
      required: ["words"],
    },
  },
] as const;

/** Ответ тула: блоки текста, итог строки и признак ошибки. */
export interface ToolResult {
  [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exit: number;
  };
  readonly isError: boolean;
}

function words(value: unknown, name: string, allowEmpty: boolean): string[] {
  if (
    !Array.isArray(value) || !value.every((word) => typeof word === "string")
  ) {
    throw new McpError(ErrorCode.InvalidParams, `${name}: нужен список строк`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `${name}: список пуст`);
  }
  return [...value];
}

/**
 * Слова строки для вызова тула (граница: имя тула и аргументы клиента).
 *
 * @throws McpError `-32602` — тула нет или аргументы не те
 */
export function lineOf(
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (name === "mpu") return words(args?.words, "words", false);
  if (name === "help") {
    return [...words(args?.path ?? [], "path", true), "help"];
  }
  throw new McpError(ErrorCode.InvalidParams, `нет тула ${name}`);
}

function failed(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function finished(stdout: string, stderr: string, exit: number): ToolResult {
  const content = [{ type: "text" as const, text: stdout }];
  if (stderr !== "") content.push({ type: "text", text: `stderr:\n${stderr}` });
  return {
    content,
    structuredContent: { stdout, stderr, exit },
    isError: exit !== 0,
  };
}

/**
 * Строка до `exit`: вопрос — человеку, ответ — `back`, потоки всех
 * ответов — подряд.
 *
 * @param line слова строки
 * @param back строка `mpu-back`
 * @param asker кто отвечает на вопросы
 * @param requestId вызов тула — поток для вопроса
 */
export async function runLine(
  line: readonly string[],
  back: BackLine,
  asker: Asker,
  requestId: string | number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ToolResult> {
  let reply = await back.start(line, asker.human, options);
  let stdout = "";
  let stderr = "";
  while (true) {
    // Ответ `back` — данные границы контракта: вид — его ключ.
    if ("failed" in reply) return failed(reply.failed);
    const collected = reply.collected;
    stdout += collected.stdout;
    stderr += collected.stderr;
    if ("exit" in collected) return finished(stdout, stderr, collected.exit);
    const verdict = await asker.ask(collected.ask, requestId, options);
    reply = await back.answer(collected.ticket, verdict, options);
  }
}
