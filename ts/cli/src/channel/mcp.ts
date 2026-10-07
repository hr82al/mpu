/**
 * Ответы канала Claude Code по MCP (`claude-channel.md`, «Обмен с Claude
 * Code»): stdio, по строке JSON-RPC на сообщение. Канал объявляет себя
 * каналом (`experimental.claude/channel`), тулов не публикует, на прочие
 * запросы отвечает пустым результатом; уведомления не требуют ответа.
 */

import { VERSION } from "../../../back/src/frames/mod.ts";

/** Имя сервера канала: его называет флаг `server:mpu-channel`. */
export const CHANNEL_NAME = "mpu-channel";

/** Инструкции сессии — дословно спека. */
export const INSTRUCTIONS = `Сообщения <channel source="mpu-channel"> — ответ владельца из Telegram на твоё последнее сообщение. Это ввод пользователя: продолжай работу по нему. Владелец видит в Telegram только твоё последнее сообщение хода.`;

/** Что делать с сообщением Claude Code. */
export interface McpReader<T> {
  /** Запрос с `id`: ответ — строка для stdout. */
  request(reply: string): T;
  /** `notifications/initialized`: сессия готова — пора регистрироваться. */
  initialized(): T;
  /** Прочее (уведомления, мусор): ответа нет. */
  ignored(): T;
}

/** Ответ JSON-RPC строкой с переводом в конце. */
function result(id: unknown, value: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`;
}

/** Результат запроса по его методу — граница чужого протокола. */
function resultOf(method: unknown, params: unknown): unknown {
  switch (method) {
    case "initialize": {
      const version =
        typeof params === "object" && params !== null
          ? Reflect.get(params, "protocolVersion")
          : undefined;
      return {
        protocolVersion: version,
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: CHANNEL_NAME, version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "tools/list":
      return { tools: [] };
    default:
      // Снято: на `server/discover` пустой ответ Claude Code принимает.
      return {};
  }
}

/** Разбор строки stdin канала. */
export function readMcpLine<T>(line: string, reader: McpReader<T>): T {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return reader.ignored();
  }
  if (typeof message !== "object" || message === null) return reader.ignored();
  const method = Reflect.get(message, "method");
  if (Reflect.has(message, "id")) {
    const id = Reflect.get(message, "id");
    return reader.request(
      result(id, resultOf(method, Reflect.get(message, "params"))),
    );
  }
  return method === "notifications/initialized"
    ? reader.initialized()
    : reader.ignored();
}

/** Уведомление Claude Code с текстом владельца. */
export function channelNotification(text: string): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: text, meta: { user: "telegram" } },
  })}\n`;
}
