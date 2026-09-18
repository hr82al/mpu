/**
 * Запросы `POST /rpc` (`platform/back-rpc.md`, «Запросы»): JSON-RPC 2.0
 * без исполнения строк — снимок дерева, правила, схема.
 */

import {
  errorBody,
  readMessage,
  resultBody,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  type RpcBody,
} from "../mcp/mod.ts";

/** Методы по имени: у каждого нет параметров, результат — данные. */
export type Methods = ReadonlyMap<string, () => unknown>;

function parsed(text: string): { readonly body: unknown } | undefined {
  try {
    return { body: JSON.parse(text) };
  } catch {
    // Причина разбора клиенту не нужна: ответ один на все её виды.
    return undefined;
  }
}

/**
 * Ответ на тело запроса. Нотификация (без `id`) исполняется и ответа не
 * получает — `undefined`.
 *
 * @param text тело запроса как есть
 * @param methods методы сервера
 */
export function answerRpc(
  text: string,
  methods: Methods,
): RpcBody | undefined {
  const request = parsed(text);
  if (request === undefined) {
    return errorBody(null, RPC_PARSE_ERROR, "Parse error");
  }
  const message = readMessage(request.body);
  if (message === undefined) {
    return errorBody(null, RPC_INVALID_REQUEST, "Invalid request");
  }
  const method = methods.get(message.method);
  const id = message.id;
  if (method === undefined) {
    if (id === undefined) return undefined;
    return errorBody(id, RPC_METHOD_NOT_FOUND, "Method not found");
  }
  let result: unknown;
  try {
    result = method();
  } catch (err) {
    if (id === undefined) return undefined;
    const reason = err instanceof Error ? err.message : String(err);
    return errorBody(id, RPC_INTERNAL_ERROR, reason);
  }
  if (id === undefined) return undefined;
  return resultBody(id, result);
}
