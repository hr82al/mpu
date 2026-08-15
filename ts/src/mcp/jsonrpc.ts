/**
 * Разбор и сборка сообщений JSON-RPC ревизии протокола MCP. Транспорта
 * здесь нет: на вход приходит уже разобранное тело, на выход уходят
 * данные ответа — HTTP их только переносит.
 */

/** Ревизия протокола, которую сервер обслуживает. */
export const PROTOCOL_VERSION = "2026-07-28";

/** Версии, о которых сервер сообщает в `server/discover`. */
export const SUPPORTED_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

/** Коды ошибок: свои у протокола MCP, прочие — из JSON-RPC. */
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_HEADER_MISMATCH = -32020;
export const RPC_UNSUPPORTED_VERSION = -32022;

/** Идентификатор запроса; у нотификации его нет. */
export type RpcId = string | number;

/** Разобранное сообщение запроса. */
export interface RpcMessage {
  /** Отсутствует у нотификации — ответного тела она не получает. */
  readonly id?: RpcId;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Ключ версии протокола в `_meta` параметров вызова. */
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

/** Ключ идентичности сервера в `_meta` результата `server/discover`. */
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Разбирает тело запроса; не JSON-RPC-сообщение — `undefined`. */
export function readMessage(body: unknown): RpcMessage | undefined {
  const record = asRecord(body);
  if (record === undefined) return undefined;
  if (record["jsonrpc"] !== "2.0") return undefined;
  const method = record["method"];
  if (typeof method !== "string") return undefined;
  const id = record["id"];
  const params = asRecord(record["params"]) ?? {};
  if (id === undefined) return { method, params };
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return { id, method, params };
}

/** Версия протокола, объявленная в `_meta` сообщения; нет — `undefined`. */
export function messageVersion(message: RpcMessage): string | undefined {
  const meta = asRecord(message.params["_meta"]);
  const version = meta?.[META_VERSION];
  return typeof version === "string" ? version : undefined;
}

/** Ошибка в теле ответа. */
interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Тело ответа: ровно одно из `result` и `error`. */
export interface RpcBody {
  readonly jsonrpc: "2.0";
  /** `null`, когда идентификатор запроса не удалось прочитать. */
  readonly id: RpcId | null;
  readonly result?: unknown;
  readonly error?: RpcError;
}

/** Тело успешного ответа. */
export function resultBody(id: RpcId, result: unknown): RpcBody {
  return { jsonrpc: "2.0", id, result };
}

/** Тело ответа с ошибкой; `id` неизвестен — `null` по протоколу. */
export function errorBody(
  id: RpcId | null,
  code: number,
  message: string,
  data?: unknown,
): RpcBody {
  const error = data === undefined
    ? { code, message }
    : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}

/**
 * Значение заголовка для сверки с телом. Форма `=?base64?…?=` —
 * способ передать в заголовке не-ASCII: перед сверкой декодируется.
 */
export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/s.exec(value);
  if (match === null) return value;
  const bytes = Uint8Array.from(atob(match[1]), (ch) => ch.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}
