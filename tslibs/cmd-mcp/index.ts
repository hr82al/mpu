/**
 * Поверхность пакета: ядро MCP-сервера (`platform/mcp-server.md`) —
 * чистая функция «запрос → ответ» над реестром команд, сборка профилей
 * тулов по закрытому списку публикации, токен доступа и помощники
 * JSON-RPC, общие с RPC процесса `mpu-back`. Реестр и сам список
 * приносит потребитель: пакет команд приложения не знает.
 */

export {
  handleMcp,
  type McpDeps,
  type McpRequest,
  type McpResponse,
} from "./src/server.ts";
export {
  errorBody,
  readMessage,
  resultBody,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  type RpcBody,
} from "./src/jsonrpc.ts";
export { nativeEntry } from "./src/native_tool.ts";
export {
  Publication,
  type PublicationList,
  ToolPolicyError,
} from "./src/publication.ts";
export { ensureAccessToken } from "./src/token.ts";
export { DESCRIPTION_LIMIT } from "./src/tool.ts";
export {
  type Profile,
  PROFILE_INSTRUCTIONS,
  profileTools,
  type Tool,
  type ToolEntry,
  toolName,
  toolsSnapshot,
} from "./src/tools.ts";
