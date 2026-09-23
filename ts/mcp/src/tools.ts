/**
 * Два тула переводчика (`platform/mcp-objects.md`, «Тулы»): `help` и
 * `mpu`. Оба — одна операция: строка `mpu-back` до `exit`, с ответами
 * человека на вопросы. О командах тулы не знают: справку и исполнение даёт
 * `back`.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { OutputFile, RefusalData } from "../../back/src/frames/mod.ts";
import { GRAMMAR } from "../../back/src/messages/mod.ts";
import type { Asker } from "./asker.ts";
import type { BackLine } from "./back.ts";

/**
 * Описание тула `mpu` (`fixtures/mcp-objects/tool-desc.txt`): слова
 * грамматики подставлены из константы разбора (`platform/line-grammar.md`
 * [D.1]) — их написание живёт в одном месте.
 */
const { open, close, literal, stdin } = GRAMMAR;
const MPU_DESCRIPTION =
  `mpu — Smalltalk на словах к mpu-back. Вход — массив слов \`words\`.

- Голое слово — сообщение: \`kiten ls\`. Значение — только ключом: \`ключ: значение\` ≡ \`--ключ значение\`; одно слово массива — одно значение, пробелы можно: \`sql: "select 1"\`.
- Порядок: команда → варианты → ключи → \`${close}\` → сообщения результату. Вариант — слово ДО ключей: \`process dry target: 54\`, \`logs portainer target: sl-1 since: 1h\`.
- \`${close}\` закрывает выражение; слово после — результату: формат (\`${close} json\`, \`${close} md\`; список — \`<команда> formats\`) или отбор: \`kiten ls ${close} size\`, \`kiten ls where: column is: review ${close} pick: title\` (поле всех), \`… ${close} first title\` (поле первой), \`${close} first: 3\`, \`where: <поле> is:|less:|greater:|includes: <значение>\`.
- Ключи везде одни: \`target:\` где (клиент по номеру/имени/части, \`sl-N\`, \`dev:N\`), \`id:\` номер сущности, \`text:\` текст, \`query:\` поиск, \`since:\`/\`until:\` время, \`limit:\` сколько.
- Значение из команды — группой: \`id: ${open} kiten ls ${close} first id\`; из stdin — \`sql: ${stdin}\`.
- \`it\` — последний результат без повторного запроса: \`it ${close} json\`.
- Запись или отправка — строка начинается \`ask\`: \`ask sql target: sl-1 sql: "…"\`, \`ask kiten comment id: 5 text: ok\`.
- Слово грамматики как значение — через \`${literal}\`: \`text: ${literal} ${close}\`.
- Справка — \`help\` последним: \`kiten card help\`; ключи — \`… keys\`, варианты — \`… variants\`.
- Отказ несёт \`refusal.hint\` — исправленную строку \`words\`: вызови её.`;

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
    /** Вывод целиком; отдан файлом — поля нет, а место его — `file`. */
    readonly stdout?: string;
    /** Вывод файлом (`platform/long-output.md`, §4); иначе поля нет. */
    readonly file?: {
      readonly path: string;
      readonly bytes: number;
      readonly lines: number;
    };
    readonly stderr: string;
    readonly exit: number;
    /** Отказ строки объектом (`platform/refusal-object.md`); нет — поля нет. */
    readonly refusal?: RefusalData;
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

/**
 * Итог строки: потоки всех ответов и последний ответ `back` — его код и
 * отказ-объект, если строка отказана.
 */
function finished(
  stdout: string,
  stderr: string,
  last: {
    readonly exit: number;
    readonly refusal?: RefusalData;
    readonly file?: OutputFile;
  },
): ToolResult {
  const { exit, refusal, file } = last;
  // Поля границы: у строки без отказа или без файла их нет вовсе.
  const refused = refusal === undefined ? {} : { refusal };
  const output = file === undefined ? { text: stdout, fields: { stdout } } : {
    // Куски до вопроса пришли целиком — они остаются перед путём.
    text: stdout + fileNotice(file),
    fields: {
      file: { path: file.path, bytes: file.bytes, lines: file.lines },
    },
  };
  const content = [{ type: "text" as const, text: output.text }];
  if (stderr !== "") content.push({ type: "text", text: `stderr:\n${stderr}` });
  return {
    content,
    structuredContent: { ...output.fields, stderr, exit, ...refused },
    isError: exit !== 0,
  };
}

/**
 * Текст ответа вместо вывода, отданного файлом (`platform/long-output.md`,
 * §4); у коллекции — строка среза из `it` без повторного запроса.
 */
function fileNotice(file: OutputFile): string {
  const kib = Math.ceil(file.bytes / 1024);
  const where = `вывод ${file.lines} строк, ${kib} КиБ — файл ${file.path}`;
  if (!file.slice) return where;
  return `${where}; срез без повторного запроса: it ${close} last: 100 · ` +
    `it ${close} size`;
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
  options: { readonly signal?: AbortSignal; readonly caller?: string } = {},
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
    if ("exit" in collected) return finished(stdout, stderr, collected);
    const verdict = await asker.ask(collected.ask, requestId, options);
    reply = await back.answer(collected.ticket, verdict, options);
  }
}
