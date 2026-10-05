/**
 * Вызов инструмента из payload'а `PreToolUse` (`claude-hook-pre-tool-use.md`,
 * «Ввод»): слова строки `mpu` или готовый ответ. Читаются три поля, прочие
 * игнорируются; первая нарушенная проверка сверху вниз даёт причину.
 */

import { type HookReply, NOT_MPU, Undecided, unparsedInput } from "./reply.ts";
import { ShellEvent, shellWords } from "./shell.ts";

/** Имя MCP-тула `mpu`: другое имя сервера — «не вызов mpu». */
const MCP_TOOL = "mcp__mpu__mpu";

/** Решение по словам строки `mpu` (без самого `mpu`). */
export type Consult = (words: readonly string[]) => Promise<HookReply>;

/** Вызов инструмента: слова строки — решающему, прочее — свой ответ. */
export interface ToolCall {
  reply(consult: Consult): Promise<HookReply>;
}

/** Bash: слова — разбором оболочки, без первого `mpu`. */
export class BashCall implements ToolCall {
  readonly #command: string;

  constructor(command: string) {
    this.#command = command;
  }

  reply(consult: Consult): Promise<HookReply> {
    let words: readonly string[];
    try {
      words = shellWords(this.#command);
    } catch (err) {
      if (!(err instanceof ShellEvent)) throw err;
      return Promise.resolve(new Undecided(err.reason));
    }
    return consult(words.slice(1));
  }
}

/** MCP-тул `mpu`: слова как есть — оболочки нет. */
export class McpCall implements ToolCall {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = [...words];
  }

  reply(consult: Consult): Promise<HookReply> {
    return consult(this.#words);
  }
}

/** Не Bash и не `mcp__mpu__mpu`. */
export const NotMpu: ToolCall = {
  reply: () => Promise.resolve(new Undecided(NOT_MPU)),
};

/** Payload не тот: причина — что именно. */
export class Unparsed implements ToolCall {
  readonly #what: string;

  constructor(what: string) {
    this.#what = what;
  }

  reply(): Promise<HookReply> {
    return Promise.resolve(new Undecided(unparsedInput(this.#what)));
  }
}

const NOT_OBJECT = "stdin — не JSON-объект";

/** Поля payload'а — после проверки, что это объект. */
type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Вызов из текста stdin хука.
 *
 * @param text stdin целиком
 */
export function toolCallOf(text: string): ToolCall {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return new Unparsed(NOT_OBJECT);
  }
  if (!isFields(payload)) return new Unparsed(NOT_OBJECT);
  const name = payload.tool_name;
  if (typeof name !== "string") return new Unparsed("нет tool_name");
  switch (name) {
    case "Bash":
      return withInput(payload, bashCall);
    case MCP_TOOL:
      return withInput(payload, mcpCall);
    default:
      return NotMpu;
  }
}

/** `tool_input` — объект; тогда вызов из него. */
function withInput(
  payload: Fields,
  callOf: (input: Fields) => ToolCall,
): ToolCall {
  const input = payload.tool_input;
  if (!isFields(input)) return new Unparsed("tool_input — не объект");
  return callOf(input);
}

function bashCall(input: Fields): ToolCall {
  const command = input.command;
  if (typeof command !== "string") {
    return new Unparsed("tool_input.command — не строка");
  }
  return new BashCall(command);
}

function mcpCall(input: Fields): ToolCall {
  const words = input.words;
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string")) {
    return new Unparsed("tool_input.words — не список строк");
  }
  if (words.length === 0) return new Unparsed("tool_input.words пуст");
  return new McpCall(words);
}
