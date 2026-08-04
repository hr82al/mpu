/**
 * Ядро MCP-сервера: чистая функция «запрос → ответ» над реестром
 * команд (`platform/mcp-server.md`). Сокета, сети и разбора HTTP здесь
 * нет — их приносит адаптер транспорта; ядро получает уже разобранное
 * тело и возвращает данные ответа. Побочные эффекты — только те, что
 * порождает исполняемая команда через `io`.
 */

import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import {
  decodeHeaderValue,
  errorBody,
  messageVersion,
  META_SERVER_INFO,
  readMessage,
  resultBody,
  RPC_HEADER_MISMATCH,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_UNSUPPORTED_VERSION,
  type RpcBody,
  type RpcId,
  type RpcMessage,
  SUPPORTED_VERSIONS,
} from "./jsonrpc.ts";
import {
  findTool,
  type Profile,
  PROFILE_INSTRUCTIONS,
  profileTools,
  type Tool,
} from "./tools.ts";

export type { Profile, Tool, ToolEntry } from "./tools.ts";
export { PROFILE_INSTRUCTIONS, profileTools, toolName } from "./tools.ts";

/** Запрос к ядру: то, что адаптер извлёк из HTTP. */
export interface McpRequest {
  /** HTTP-метод: путь профиля принимает только `POST`. */
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Разобранное тело; тела нет — `null`. */
  readonly body: unknown;
}

/** Ответ ядра: адаптер переносит его в HTTP как есть. */
export interface McpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Тело ответа; протокол тела не предполагает — `null`. */
  readonly body: unknown;
}

/** Зависимости ядра: реестр, окружение исполнения и версия сборки. */
export interface McpDeps {
  readonly io: CommandIo;
  readonly commands: readonly Command[];
  /** Версия сборки бинаря: по ней виден отставший процесс сервера. */
  readonly version: string;
}

/** Обязательные заголовки запроса; сверяются со значениями тела. */
const HEADER_METHOD = "Mcp-Method";
const HEADER_NAME = "Mcp-Name";
const HEADER_VERSION = "MCP-Protocol-Version";

/** Исполняет запрос к профилю и возвращает данные ответа. */
export async function handleMcp(
  request: McpRequest,
  deps: McpDeps,
): Promise<McpResponse> {
  const profile = profileOf(request.path);
  if (profile === undefined) return { status: 404, headers: {}, body: null };
  if (request.method !== "POST") {
    return { status: 405, headers: { Allow: "POST" }, body: null };
  }

  const message = readMessage(request.body);
  if (message === undefined) {
    return json(
      400,
      errorBody(
        null,
        RPC_INVALID_REQUEST,
        "Invalid request: not a JSON-RPC message",
      ),
    );
  }
  // Нотификация принимается без ответного тела: отвечать по протоколу
  // нечему, а отказ клиент воспринял бы как сбой.
  if (message.id === undefined) return { status: 202, headers: {}, body: null };
  const id = message.id;

  const checked = checkHeaders(request.headers, message);
  if ("problem" in checked) {
    return json(400, errorBody(id, RPC_HEADER_MISMATCH, checked.problem));
  }
  if (!SUPPORTED_VERSIONS.includes(checked.version)) {
    return json(
      400,
      errorBody(
        id,
        RPC_UNSUPPORTED_VERSION,
        `Unsupported protocol version: ${checked.version}`,
        { supported: SUPPORTED_VERSIONS, requested: checked.version },
      ),
    );
  }

  switch (message.method) {
    case "server/discover":
      return json(200, resultBody(id, discover(profile, deps.version)));
    case "tools/list":
      return json(200, resultBody(id, listTools(deps.commands, profile)));
    case "tools/call":
      return json(200, await callTool(id, message, profile, deps));
    default:
      return json(
        404,
        errorBody(
          id,
          RPC_METHOD_NOT_FOUND,
          `Method not found: ${message.method}`,
        ),
      );
  }
}

/** Результат `server/discover`. */
interface DiscoverResult {
  readonly resultType: "complete";
  readonly supportedVersions: readonly string[];
  readonly capabilities: { readonly tools: Record<string, never> };
  readonly _meta: Readonly<
    Record<string, { readonly name: string; readonly version: string }>
  >;
  readonly instructions: string;
}

/**
 * Ответ `server/discover`: версии, возможности, идентичность сборки и
 * инструкции профиля. Инструкции живут здесь, а не в `tools/list`:
 * клиент читает их при подключении, до списка тулов.
 */
function discover(profile: Profile, version: string): DiscoverResult {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    _meta: { [META_SERVER_INFO]: { name: "mpu", version } },
    instructions: PROFILE_INSTRUCTIONS[profile],
  };
}

function listTools(
  commands: readonly Command[],
  profile: Profile,
): { readonly tools: readonly Tool[] } {
  return { tools: profileTools(commands, profile).map((entry) => entry.tool) };
}

/**
 * Исполнение тула. Классы исходов различаются по типу ошибки, а не по
 * тексту: ошибка ввода уходит JSON-RPC-ошибкой (её исправляет клиент),
 * доменная — содержимым результата с признаком ошибки, чтобы агент
 * прочитал её и исправился.
 */
async function callTool(
  id: RpcId,
  message: RpcMessage,
  profile: Profile,
  deps: McpDeps,
): Promise<RpcBody> {
  const name = message.params["name"];
  if (typeof name !== "string") {
    return errorBody(
      id,
      RPC_INVALID_PARAMS,
      "Invalid params: tool name is missing",
    );
  }
  const entry = findTool(deps.commands, profile, name);
  if (entry === undefined) {
    return errorBody(id, RPC_INVALID_PARAMS, `Unknown tool "${name}"`);
  }
  const input = message.params["arguments"] ?? {};
  try {
    const result = await entry.command.invokeInput(input, deps.io);
    return resultBody(id, {
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
  } catch (err) {
    if (err instanceof UsageError) {
      return errorBody(
        id,
        RPC_INVALID_PARAMS,
        `invalid arguments for tool "${name}": ${err.message}`,
      );
    }
    if (err instanceof DomainError) {
      return resultBody(id, {
        isError: true,
        content: [
          { type: "text", text: formatCommandError(entry.command.path, err) },
        ],
      });
    }
    // Сбой самой реализации: клиенту он ошибка транспорта, а не итог
    // команды. Сервер при этом остаётся живым.
    const reason = err instanceof Error ? err.message : String(err);
    return errorBody(
      id,
      RPC_INTERNAL_ERROR,
      `Internal error in tool "${name}": ${reason}`,
    );
  }
}

/** Итог проверки заголовков: причина отказа либо запрошенная версия. */
type HeaderCheck = { readonly problem: string } | { readonly version: string };

/**
 * Проверяет, что обязательные заголовки на месте и совпадают с телом.
 * Версия возвращается отсюда, а не читается повторно: после проверки
 * она заведомо есть, и второе чтение завело бы ветку «а если нет».
 */
function checkHeaders(
  headers: Readonly<Record<string, string>>,
  message: RpcMessage,
): HeaderCheck {
  const version = header(headers, HEADER_VERSION);
  if (version === undefined) {
    return { problem: `Missing required header: ${HEADER_VERSION}` };
  }
  if (header(headers, HEADER_METHOD) === undefined) {
    return { problem: `Missing required header: ${HEADER_METHOD}` };
  }
  const name = message.params["name"];
  if (
    message.method === "tools/call" &&
    header(headers, HEADER_NAME) === undefined
  ) {
    return { problem: `Missing required header: ${HEADER_NAME}` };
  }
  const problem = mismatch(headers, HEADER_METHOD, message.method) ??
    mismatch(headers, HEADER_VERSION, messageVersion(message)) ??
    mismatch(headers, HEADER_NAME, typeof name === "string" ? name : undefined);
  return problem === undefined ? { version } : { problem };
}

/** Расхождение заголовка с телом; тело о значении молчит — не сверяем. */
function mismatch(
  headers: Readonly<Record<string, string>>,
  name: string,
  bodyValue: string | undefined,
): string | undefined {
  const headerValue = header(headers, name);
  if (headerValue === undefined || bodyValue === undefined) return undefined;
  if (headerValue === bodyValue) return undefined;
  return `Header mismatch: ${name} header value '${headerValue}' ` +
    `does not match body value '${bodyValue}'`;
}

/** Значение заголовка без учёта регистра имени и в декодированном виде. */
function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return decodeHeaderValue(value);
  }
  return undefined;
}

function profileOf(path: string): Profile | undefined {
  if (path === "/ro") return "ro";
  if (path === "/rw") return "rw";
  return undefined;
}

function json(status: number, body: unknown): McpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body,
  };
}
