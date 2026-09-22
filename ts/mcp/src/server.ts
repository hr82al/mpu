/**
 * HTTP переводчика (`platform/mcp-objects.md`, «Транспорт и доступ»):
 * `/mcp` на петле, `Origin` — петля, свой токен клиента, сессии SDK;
 * неизвестная сессия — 404 (только на него клиент сам переподключается).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { type Asker, eliciting, NOBODY } from "./asker.ts";
import type { BackLine } from "./back.ts";
import { lineOf, runLine, TOOLS } from "./tools.ts";

const LOOPBACK = "127.0.0.1";
const PATH = "/mcp";
const SESSION_HEADER = "mcp-session-id";
const HEALTH = "/health";

/**
 * Жив ли переводчик — без токена. `pid` — чтобы установка отличила новый
 * процесс от старого (`platform/supervisor-install.md`, шаг 7).
 */
function health(request: Request): Response {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  return Response.json({ ok: true, pid: Deno.pid });
}

/** Страница с той же машины — и только она. */
const ORIGIN_HOSTS: ReadonlySet<string> = new Set([
  LOOPBACK,
  "localhost",
  "[::1]",
]);

/** Что нужно переводчику. */
export interface McpOptions {
  /** Порт; `0` — выдаёт ОС. */
  readonly port: number;
  /** Токен клиента MCP (`mcp-token`). */
  readonly token: string;
  readonly back: BackLine;
  readonly version: string;
}

/** Поднятый переводчик. */
export interface RunningMcp {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void>;
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function allowsOrigin(origin: string): boolean {
  try {
    return ORIGIN_HOSTS.has(new URL(origin).hostname);
  } catch {
    // Неразбираемый Origin — заведомо не свой: отказ, а не падение.
    return false;
  }
}

/** Сессия: сервер SDK и его транспорт. */
interface Session {
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

/** Сервер SDK одной сессии: два тула, спрашивающий — по `initialize`. */
function sessionServer(options: McpOptions): Server {
  const server = new Server(
    { name: "mpu-mcp", version: options.version },
    { capabilities: { tools: {} } },
  );
  let asker: Asker = NOBODY;
  server.oninitialized = () => {
    const elicits = server.getClientCapabilities()?.elicitation !== undefined;
    asker = elicits ? eliciting(server) : NOBODY;
  };
  server.setRequestHandler(
    ListToolsRequestSchema,
    () => ({ tools: [...TOOLS] }),
  );
  server.setRequestHandler(
    CallToolRequestSchema,
    (
      request: CallToolRequest,
      // `signal` SDK взводит у идущего запроса, когда клиент отменил
      // вызов или порвал транспорт (`platform/mcp-cancel.md`): без него
      // отмену некому увидеть.
      extra: { readonly requestId: RequestId; readonly signal: AbortSignal },
    ) =>
      runLine(
        lineOf(request.params.name, request.params.arguments),
        options.back,
        asker,
        extra.requestId,
        { signal: extra.signal },
      ),
  );
  return server;
}

class Translator {
  readonly #options: McpOptions;
  readonly #sessions = new Map<string, Session>();
  /** Закрытия ушедших сессий: остановка ждёт их, а не бросает. */
  #closing: Promise<void> = Promise.resolve();

  constructor(options: McpOptions) {
    this.#options = options;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== PATH && path !== HEALTH) return empty(404);
    const origin = request.headers.get("Origin");
    if (origin !== null && !allowsOrigin(origin)) return empty(403);
    if (path === HEALTH) return health(request);
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${this.#options.token}`) return empty(401);
    const id = request.headers.get(SESSION_HEADER);
    if (id === null) return await this.#open(request);
    const session = this.#sessions.get(id);
    if (session === undefined) return empty(404);
    return await session.transport.handleRequest(request);
  }

  async stop() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) await session.server.close();
    await this.#closing;
  }

  /** Новая сессия; запрос не `initialize` — SDK отказывает, сессии нет. */
  async #open(request: Request): Promise<Response> {
    const server = sessionServer(this.#options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        this.#sessions.set(id, { server, transport });
      },
      onsessionclosed: (id: string) => {
        const closed = this.#sessions.get(id);
        this.#sessions.delete(id);
        if (closed === undefined) return;
        // Клиент ушёл — идущие вызовы этой сессии обрывает SDK, но
        // только при закрытии сервера: без него строка осталась бы
        // жить, хотя её итога уже некому ждать
        // (`platform/mcp-cancel.md`).
        this.#closing = this.#closing.then(() => closed.server.close()).catch(
          () => {
            // Закрытие чужой сессии — уборка: её отказ не должен
            // всплыть отказом постороннего по времени `stop()`, а
            // чинить тут нечего — клиента уже нет.
          },
        );
      },
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (transport.sessionId === undefined) await server.close();
    return response;
  }
}

/**
 * Поднимает переводчик на петле.
 *
 * @throws Deno.errors.AddrInUse — порт занят
 */
export async function serveMcp(options: McpOptions): Promise<RunningMcp> {
  const translator = new Translator(options);
  const address = Promise.withResolvers<Deno.NetAddr>();
  const server = Deno.serve({
    hostname: LOOPBACK,
    port: options.port,
    onListen: address.resolve,
  }, (request) => translator.handle(request));
  const bound = await address.promise;
  let stopping: Promise<void> | undefined;
  return {
    port: bound.port,
    hostname: bound.hostname,
    stop: () =>
      stopping ??= (async () => {
        await translator.stop();
        await server.shutdown();
      })(),
  };
}
