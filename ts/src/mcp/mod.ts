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
import type { InvokeLog, InvokeRecording } from "../invokelog/mod.ts";
import {
  findTool,
  type Profile,
  PROFILE_INSTRUCTIONS,
  profileTools,
  type Tool,
  type ToolEntry,
} from "./tools.ts";

export type { Profile, Tool, ToolEntry } from "./tools.ts";
export {
  PROFILE_INSTRUCTIONS,
  profileTools,
  toolName,
  ToolPolicyError,
  toolsSnapshot,
} from "./tools.ts";

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
  /**
   * Журнал вызовов: вызов тула — вторая точка входа бинаря и
   * журналируется наравне с CLI (`platform/invoke-log.md`).
   */
  readonly log: InvokeLog;
}

/** Обязательные заголовки запроса; сверяются со значениями тела. */
const HEADER_METHOD = "Mcp-Method";
const HEADER_NAME = "Mcp-Name";
const HEADER_VERSION = "MCP-Protocol-Version";

/**
 * Ревизии классического рукопожатия (`initialize`), которые сервер
 * принимает ради живых клиентов: Claude Code и другие агенты ревизию
 * `2026-07-28` ещё не говорят. У классического запроса обязательных
 * `Mcp-*`-заголовков нет: до согласования версии их не существовало.
 */
const CLASSIC_VERSIONS: readonly string[] = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

/** Ответ `initialize`, когда запрошенная клиентом версия не знакома. */
const CLASSIC_DEFAULT = "2025-06-18";

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

  // Запрос без заголовка версии или со старой ревизией — классическое
  // рукопожатие: заголовков `Mcp-*` такой клиент не шлёт, требовать их
  // не с кого. Незнакомая версия в заголовке остаётся отказом ниже.
  const version = header(request.headers, HEADER_VERSION);
  if (version === undefined || CLASSIC_VERSIONS.includes(version)) {
    return handleClassicHandshake(id, message, profile, deps);
  }

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

/**
 * Классическое рукопожатие старых ревизий: `initialize` вместо
 * `server/discover`, `ping` для проверки живости, те же тулы. Формы
 * запросов и ответов `tools/list`/`tools/call` в старых ревизиях
 * совпадают с текущей — исполнение общее.
 */
async function handleClassicHandshake(
  id: RpcId,
  message: RpcMessage,
  profile: Profile,
  deps: McpDeps,
): Promise<McpResponse> {
  switch (message.method) {
    case "initialize":
      return json(
        200,
        resultBody(id, initializeResult(message, profile, deps.version)),
      );
    case "ping":
      return json(200, resultBody(id, {}));
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

/** Результат `initialize`: аналог `server/discover` старых ревизий. */
function initializeResult(
  message: RpcMessage,
  profile: Profile,
  version: string,
): Readonly<Record<string, unknown>> {
  const requested = message.params["protocolVersion"];
  const negotiated =
    typeof requested === "string" && CLASSIC_VERSIONS.includes(requested)
      ? requested
      : CLASSIC_DEFAULT;
  return {
    protocolVersion: negotiated,
    capabilities: { tools: {} },
    serverInfo: { name: "mpu", version },
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
 *
 * Вызов тула журналируется наравне с CLI-вызовом: одна запись, `pid` и
 * `cwd` — серверного процесса (`platform/invoke-log.md`). У тула
 * маршрута `legacy` пометки журнала нет: там запись делает сам
 * Python-подпроцесс, и вторая была бы дублем.
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
  const record = deps.log.begin({ kind: "tool", path: entry.path, input });
  if (entry.journal !== undefined) record.nativeCall(entry.journal);
  const outcome = await invokeTool(entry, input, recordedIo(deps.io, record));
  if (outcome.kind === "ok") record.out(outcome.text);
  else record.err(outcome.text);
  await record.finish(EXIT_CODES[outcome.kind]);
  return bodyOf(id, outcome);
}

/** Чем кончился вызов тула. Ответ клиенту и запись — уже проекции. */
type ToolOutcome =
  | {
    readonly kind: "ok";
    readonly text: string;
    /** У маршрута `legacy` схемы результата нет — только текст. */
    readonly structured?: unknown;
  }
  | { readonly kind: "domain" | "usage" | "internal"; readonly text: string };

/**
 * Код исхода в записи журнала: те же классы, что CLI переводит в код
 * возврата процесса, — ошибка ввода 2, всё прочее 1
 * (`src/entrypoint/mod.ts`).
 */
const EXIT_CODES: Readonly<Record<ToolOutcome["kind"], number>> = {
  ok: 0,
  domain: 1,
  usage: 2,
  internal: 1,
};

async function invokeTool(
  entry: ToolEntry,
  input: unknown,
  io: CommandIo,
): Promise<ToolOutcome> {
  const name = entry.tool.name;
  try {
    const result = await entry.invoke(input, io);
    // Тул сообщил о неуспехе сам (ненулевой код подпроцесса): это
    // доменная ошибка, её агент читает и исправляется.
    if (result.isError) return { kind: "domain", text: result.text };
    return { kind: "ok", text: result.text, structured: result.structured };
  } catch (err) {
    if (err instanceof UsageError) {
      return {
        kind: "usage",
        text: `invalid arguments for tool "${name}": ${err.message}`,
      };
    }
    if (err instanceof DomainError) {
      return { kind: "domain", text: formatCommandError(entry.errorName, err) };
    }
    // Сбой самой реализации: клиенту он ошибка транспорта, а не итог
    // команды. Сервер при этом остаётся живым.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "internal",
      text: `Internal error in tool "${name}": ${reason}`,
    };
  }
}

/** Ответ клиенту по исходу вызова. */
function bodyOf(id: RpcId, outcome: ToolOutcome): RpcBody {
  const content = [{ type: "text", text: outcome.text }];
  switch (outcome.kind) {
    case "ok":
      return resultBody(
        id,
        outcome.structured === undefined
          ? { content }
          : { structuredContent: outcome.structured, content },
      );
    case "domain":
      return resultBody(id, { isError: true, content });
    case "usage":
      return errorBody(id, RPC_INVALID_PARAMS, outcome.text);
    case "internal":
      return errorBody(id, RPC_INTERNAL_ERROR, outcome.text);
    default: {
      const unknown: never = outcome;
      throw new TypeError(`неизвестный исход тула: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Окружение исполнения тула, у которого служебные строки хода
 * дублируются в его запись. У CLI то же делает перехват вывода: строки
 * `progress` печатает точка входа, и в запись они попадают копией
 * (`platform/invoke-log.md`, «Побочные эффекты»). У сервера печатать их
 * некому — но в записи вызова они обязаны быть.
 */
function recordedIo(io: CommandIo, record: InvokeRecording): CommandIo {
  return {
    ...io,
    progress: (line) => {
      io.progress(line);
      record.err(`${line}\n`);
    },
  };
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
