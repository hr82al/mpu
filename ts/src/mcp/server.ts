/**
 * HTTP-транспорт MCP-сервера (`platform/mcp-server.md`). Разделение
 * обязанностей строгое: транспорт решает, дойдёт ли запрос до ядра —
 * метод, путь, `Origin`, авторизация, разбор тела; ядро решает, что
 * ответить по существу. Отказ транспорта до ядра не доходит, поэтому
 * исполнение команды невозможно без валидного токена.
 */

import { Hono } from "@hono/hono";
import { handleMcp, type McpDeps, type Profile } from "./mod.ts";
import { errorBody, RPC_INVALID_REQUEST } from "./jsonrpc.ts";

/** Интерфейс, на котором сервер слушает: только петля. */
export const LOOPBACK = "127.0.0.1";

/** Порт по умолчанию, если его не задали ни флагом, ни конфигом. */
export const DEFAULT_PORT = 7337;

/** Что нужно транспорту сверх зависимостей ядра. */
export interface ServerOptions {
  /** Поднимаемые профили: путь `/ro` и/или `/rw`. */
  readonly profiles: readonly Profile[];
  /** Токен доступа; сравнивается с заголовком `Authorization`. */
  readonly token: string;
  readonly deps: McpDeps;
  /** Остановка сервера снаружи: сигнал гасит слушающий сокет. */
  readonly signal?: AbortSignal;
}

/** Поднятый сервер: фактический адрес, ожидание конца и остановка. */
export interface RunningServer {
  /** Порт, который выдала ОС: при `port: 0` он известен только отсюда. */
  readonly port: number;
  /**
   * Интерфейс, на котором сокет реально слушает. Берётся из адреса
   * сокета, а не из настроек: утверждение «только петля» проверяемо
   * лишь по факту (`platform/mcp-server.md`).
   */
  readonly hostname: string;
  /** Завершается, когда сервер перестал слушать. */
  readonly finished: Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/**
 * Приложение транспорта без сокета: то же, что слушает порт, но
 * вызываемое напрямую. Ядро остаётся чистой функцией, а Hono отвечает
 * только за маршрут и перекладывание `Request`/`Response`.
 */
export function createMcpApp(options: ServerOptions): Hono {
  const app = new Hono();
  // Путь вне профилей — 404 без тела: тела протокол здесь не
  // предполагает, а Hono по умолчанию пишет «404 Not Found» текстом.
  app.notFound(() => new Response(null, { status: 404 }));

  for (const profile of options.profiles) {
    app.all(
      `/${profile}`,
      (context) => serve(context.req.raw, profile, options),
    );
  }
  return app;
}

/**
 * Один запрос к пути профиля: сначала причины не пускать его дальше,
 * затем ядро. Проверки идут от дешёвых к дорогим — метод, источник,
 * токен, разбор тела.
 */
async function serve(
  request: Request,
  profile: Profile,
  options: ServerOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && !isAllowedOrigin(origin)) {
    return json(403, errorBody(null, RPC_INVALID_REQUEST, forbidden(origin)));
  }
  if (!hasValidToken(request, options.token)) {
    return new Response(null, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (body === undefined) {
    return json(
      400,
      errorBody(null, RPC_INVALID_REQUEST, "Invalid request: body is not JSON"),
    );
  }
  const response = await handleMcp({
    method: request.method,
    path: `/${profile}`,
    headers: Object.fromEntries(request.headers),
    body,
  }, options.deps);
  return new Response(
    response.body === null ? null : JSON.stringify(response.body),
    { status: response.status, headers: response.headers },
  );
}

/**
 * Поднимает сервер на петле. Порт `0` отдаёт выбор ОС — фактический
 * возвращается в `RunningServer.port`, иначе его негде узнать.
 */
export async function serveMcp(
  options: ServerOptions & { readonly port: number },
): Promise<RunningServer> {
  const app = createMcpApp(options);
  // Адрес известен только из `onListen`, а он зовётся раньше, чем
  // `Deno.serve` вернёт объект сервера, — отсюда развязка промисом.
  const address = Promise.withResolvers<Deno.NetAddr>();
  const server = Deno.serve({
    hostname: LOOPBACK,
    port: options.port,
    signal: options.signal,
    onListen: address.resolve,
    onError: (err) => {
      // Сбой обработчика не должен ронять процесс сервера.
      const reason = err instanceof Error ? err.message : String(err);
      return json(500, errorBody(null, RPC_INVALID_REQUEST, reason));
    },
  }, app.fetch);
  const bound = await address.promise;
  return {
    port: bound.port,
    hostname: bound.hostname,
    finished: server.finished,
    shutdown: () => server.shutdown(),
  };
}

/**
 * Разрешённые источники фиксированы реализацией (спека, «Конфигурация»):
 * страница может обратиться к серверу только с той же машины. Запрос без
 * `Origin` принимается — так ходят не-браузерные клиенты.
 */
function isAllowedOrigin(origin: string): boolean {
  try {
    // Для IPv6 `hostname` отдаёт адрес в скобках — сравниваем с ним.
    const host = new URL(origin).hostname;
    return host === LOOPBACK || host === "localhost" || host === "[::1]";
  } catch {
    // Неразбираемый Origin — заведомо не свой: отказ, а не падение.
    return false;
  }
}

function forbidden(origin: string): string {
  return `Origin not allowed: ${origin}`;
}

/**
 * Токен запроса. Сравнение обычное, не постоянного времени: сервер
 * слушает петлю, недоверенной стороны в этой системе нет (CLAUDE.md,
 * «Права Deno»), а тайминг по петле не отличим от шума.
 */
function hasValidToken(request: Request, token: string): boolean {
  const header = request.headers.get("Authorization");
  return header !== null && header === `Bearer ${token}`;
}

/** Тело запроса как JSON; не разбирается — `undefined`. */
async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    // Причина разбора клиенту не нужна: ответ один на все её виды.
    return undefined;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
