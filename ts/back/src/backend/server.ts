/**
 * Сервер `mpu-back` (`platform/back-rpc.md`): строки по
 * WebSocket и запросы без исполнения по HTTP, только на петле. Доступ
 * решается до всего остального: путь, метод, `Origin`, токен.
 */

import { Hono } from "@hono/hono";
import { hasBearer, LOOPBACK, LOOPBACK_ORIGINS } from "../access/mod.ts";
import type { CommandIo, RemoteOutput } from "../command/mod.ts";
import type { InvokeLog } from "../invokelog/mod.ts";
import {
  lineEntry,
  policyTree,
  registryNodes,
  rulesOf,
  selectionMessages,
} from "../line/mod.ts";
import { runJournaled } from "../process/mod.ts";
import { VERSION } from "../version.ts";
import { AGENT, BROWSER, type Caller, OWNER } from "./caller.ts";
import { AGENT_DOOR, type Door, HUMAN_DOOR } from "./door.ts";
import {
  BadFrame,
  type LineRequest,
  lineRequest,
  ticketAnswerOf,
} from "../frames/mod.ts";
import { formFor, type Opened, ticketAsking } from "./http.ts";
import { linePrompt, type PromptDoor } from "./prompt.ts";
import { DETACHED, Line } from "./line.ts";
import { socketLine } from "./socket.ts";
import { Tickets } from "./tickets.ts";
import { staticFile } from "./static.ts";
import { SESSION_TTL_MS, type WebAccess } from "./web.ts";
import { DEFAULT_LINES, Lines } from "./limit.ts";
import { Workdir } from "../workdir/mod.ts";
import { answerRpc, type Methods } from "./rpc.ts";
import SCHEMA from "./schema.json" with { type: "json" };
import { DENO_FS, type SnapshotFs, writeSnapshot } from "./snapshot.ts";

/** Порт по умолчанию: рядом с MCP-сервером (7337). */
export const DEFAULT_BACK_PORT = 7338;

/** Страницы с петли и фронт (`http://mpu.localhost:7338`, порция 10). */
const ORIGINS = LOOPBACK_ORIGINS.with("mpu.localhost");

/** Подпротокол WebSocket с токеном: `bearer.<токен>`. */
const BEARER_PROTOCOL = "bearer.";

/** Что нужно серверу. */
export interface BackOptions {
  /** Порт; `0` — выдаёт ОС. */
  readonly port: number;
  /** Сколько строк исполняется разом; не сказано — `DEFAULT_LINES`. */
  readonly lines?: number;
  /** Токены доступа: основной и агентский. */
  readonly tokens: Tokens;
  /** Файл правил подтверждения; нет HOME — `undefined`. */
  readonly policyFile: string | undefined;
  /** Окружение сервера; строка получает его без stdin и терминалов. */
  readonly io: CommandIo;
  readonly log: InvokeLog;
  /** Путь снимка дерева; нет HOME — `undefined`. */
  readonly snapshotFile: string | undefined;
  /** Диагностика сервера — строка без перевода (stderr процесса). */
  readonly diagnose: (line: string) => void;
  readonly fs?: SnapshotFs;
  /** Генератор номера подтверждения; по умолчанию — случайный. */
  readonly newTicket?: () => string;
  /** Ключи и сессии входа в браузере. */
  readonly web: WebAccess;
  /** Каталог собранного фронта (`$HOME/.local/share/mpu/web`). */
  readonly webRoot: string;
}

/** Поднятый сервер. */
export interface RunningBack {
  /** Порт, который слушает сокет. */
  readonly port: number;
  /** Интерфейс сокета — из его адреса, а не из настроек. */
  readonly hostname: string;
  /** Остановка: открытые строки получают `exit`, сокет закрывается. */
  stop(): Promise<void>;
}

/** Токены доступа (`cli-client.md`, «Канал и токен»). */
export interface Tokens {
  /** Основной: пускает везде, `human` из кадра верится. */
  readonly main: string;
  /** Агентский: только канал агента и `/rpc`, `human` — всегда `false`. */
  readonly agent: string;
}

/** Как токен предъявлен. */
interface Presentation {
  shows(request: Request, token: string): boolean;
}

const HEADER: Presentation = { shows: hasBearer };

/** У WebSocket токен и в подпротоколе: браузер заголовок не задаёт. */
const HEADER_OR_PROTOCOL: Presentation = {
  shows: (request, token) =>
    hasBearer(request, token) ||
    offeredProtocols(request).includes(`${BEARER_PROTOCOL}${token}`),
};

/** Кого путь пускает: ключ и кем считается его предъявивший. */
interface Key {
  readonly token: (tokens: Tokens) => string;
  readonly caller: Caller;
}

const MAIN_KEY: Key = { token: (tokens) => tokens.main, caller: OWNER };
const AGENT_KEY: Key = { token: (tokens) => tokens.agent, caller: AGENT };

/** Что вход пути сверяет, кроме запроса. */
interface GateContext {
  readonly tokens: Tokens;
  readonly web: WebAccess;
  /** Единственный `Origin`, с которым действует cookie сессии. */
  readonly origin: string;
}

/** Вход пути: кто пришёл; не пущен — `undefined`. */
interface Gate {
  caller(request: Request, context: GateContext): Promise<Caller | undefined>;
}

/** Вход по одному из ключей, предъявленному так, как принимает путь. */
function keyed(presentation: Presentation, keys: readonly Key[]): Gate {
  return {
    caller: (request, context) =>
      Promise.resolve(
        keys.find((key) =>
          presentation.shows(request, key.token(context.tokens))
        )
          ?.caller,
      ),
  };
}

/** Имя cookie сессии браузера. */
const SESSION_COOKIE = "mpu_session";

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/**
 * Вход по cookie сессии (`specs/web.md`): права основного токена, но
 * только при `Origin` в точности `http://mpu.localhost:<порт>` — браузер
 * прикладывает cookie к запросу с любой локальной страницы.
 */
const BY_COOKIE: Gate = {
  async caller(request, context) {
    if (request.headers.get("Origin") !== context.origin) return undefined;
    const session = cookieOf(request, SESSION_COOKIE);
    if (session === undefined) return undefined;
    return (await context.web.admits(session)) ? BROWSER : undefined;
  },
};

/** Вход, пускающий по первому из пустивших. */
function either(...gates: readonly Gate[]): Gate {
  return {
    async caller(request, context) {
      for (const gate of gates) {
        const caller = await gate.caller(request, context);
        if (caller !== undefined) return caller;
      }
      return undefined;
    },
  };
}

/** Двери строки: путь, канал и вход — по способу предъявить токен. */
const DOORS: readonly {
  readonly path: string;
  readonly door: Door;
  readonly entry: (presentation: Presentation) => Gate;
}[] = [
  {
    path: "/line",
    door: HUMAN_DOOR,
    entry: (presentation) => either(keyed(presentation, [MAIN_KEY]), BY_COOKIE),
  },
  {
    path: "/agent/line",
    door: AGENT_DOOR,
    entry: (presentation) => keyed(presentation, [MAIN_KEY, AGENT_KEY]),
  },
];

/** Метод пути: его вход и обработка. */
interface Handler {
  readonly gate: Gate;
  handle(request: Request, caller: Caller): Response | Promise<Response>;
}

/** Путь без токена (`/health`, статика, обмен ключа). */
const OPEN_GATE: Gate = { caller: () => Promise.resolve(OWNER) };

function offeredProtocols(request: Request): string[] {
  const header = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  return header.split(",").map((one) => one.trim()).filter((one) => one !== "");
}

function empty(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Ключ из тела `POST /web/session`; не разобрался — пустой (такого нет). */
function keyOf(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null) return "";
    const key = Reflect.get(body, "key");
    return typeof key === "string" ? key : "";
  } catch {
    // Тело не JSON — ключа нет; ответ тот же, что на неверный ключ.
    return "";
  }
}

/**
 * Окружение строки: ввод, терминальность и переменные — из того, что
 * принёс вызывающий (`platform/call-context.md`); каталог — её
 * собственный (`platform/line-concurrency.md`); всё остальное —
 * окружение сервера. Своих дескрипторов и своего каталога сервер не
 * подставляет: ни консоль, ни каталог у него не те, что у клиента.
 */
function lineIo(
  io: CommandIo,
  line: Line,
  door: PromptDoor,
  request: LineRequest,
): CommandIo {
  const context = request.context;
  const environment = context.env.over(io.env);
  const terminals = context.terminals;
  const dir = new Workdir(request.cwd);
  return {
    ...io,
    env: (name) => environment.value(name),
    cwd: () => dir.path(),
    // Пути файлов — от каталога строки: `Deno.*` разрешает
    // относительный путь от процесса, а он больше не переезжает в
    // каталог строки.
    readFile: (path) => io.readFile(dir.resolve(path)),
    readRegularFile: (path) => io.readRegularFile(dir.resolve(path)),
    readTextFile: (path) => io.readTextFile(dir.resolve(path)),
    appendFile: (path, text) => io.appendFile(dir.resolve(path), text),
    // `launchOpener` не трогаем: его цель — не обязательно путь
    // (`sheet open` отдаёт ссылку), а путь `xlsx open` резолвит сам
    // через `io.cwd()` — то есть уже от каталога строки.
    readStdin: () => Promise.resolve(context.input.bytes()),
    stdinIsTerminal: () => terminals.stdin(),
    stdoutIsTerminal: () => terminals.stdout(),
    stderrIsTerminal: () => terminals.stderr(),
    consoleColumns: () => terminals.columns(),
    // Просьба остановиться приходит от клиента, переставшего слушать
    // (`platform/line-cancel.md`).
    signal: line.stopping(),
    // Спрашивает и копирует тот, кто позвал: сервер только просит
    // кадрами (`platform/line-prompt.md`).
    prompt: linePrompt(line, door),
    openRemoteOutput: () => remoteFrames(line),
  };
}

/**
 * Оборванный запрос — ушедший клиент: сигнал запроса ведёт в ту же
 * остановку строки, что и обрыв сокета (`platform/mcp-cancel.md`).
 * Что значит уход для конкретной формы ответа, решает она сама: у
 * потока он уже виден его отменой, у собранного ответа — только здесь.
 *
 * @param request запрос строки
 * @param opened открытый ответ этой строки
 */
function leaving(request: Request, opened: Opened): void {
  if (request.signal.aborted) {
    opened.leave();
    return;
  }
  request.signal.addEventListener("abort", () => opened.leave(), {
    once: true,
  });
}

/** Вывод удалённой команды — кадрами строки, UTF-8 по кускам. */
function remoteFrames(line: Line): RemoteOutput {
  const out = new TextDecoder();
  const err = new TextDecoder();
  const sent = async (text: string, send: (text: string) => void) => {
    if (text === "") return;
    send(text);
    // Кадр отдан — ждём, пока клиент его разберёт: иначе вывод
    // быстрой команды копился бы в памяти сервера
    // (`platform/line-cancel.md`).
    await line.ready();
  };
  return {
    out: (chunk) =>
      sent(out.decode(chunk, { stream: true }), (text) => line.stdout(text)),
    err: (chunk) =>
      sent(err.decode(chunk, { stream: true }), (text) => line.stderr(text)),
    captured: () => "",
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    // Нет пути, нет права или не каталог — исполнить строку там нельзя,
    // и ответ клиенту один: каталога нет.
    return false;
  }
}

class Back {
  readonly #options: BackOptions;
  readonly #lines: Lines;
  readonly #tickets: Tickets;
  readonly #open = new Map<Line, Promise<void>>();
  readonly #methods: Methods;
  /** `http://mpu.localhost:<порт>` — известен, когда сокет слушает. */
  #origin = "";

  constructor(options: BackOptions, snapshot: unknown) {
    this.#options = options;
    this.#lines = new Lines(options.lines ?? DEFAULT_LINES);
    this.#tickets = new Tickets(options.newTicket);
    this.#methods = new Map<string, () => unknown>([
      ["tree.snapshot", () => snapshot],
      ["policy.list", () => rulesOf(options.policyFile)],
      ["policy.tree", () => policyTree(options.policyFile)],
      ["schema", () => SCHEMA],
    ]);
  }

  /** Сокет слушает порт `port`: адрес страницы фронта известен. */
  listening(port: number) {
    this.#origin = `http://mpu.localhost:${port}`;
  }

  app(): Hono {
    const app = new Hono();
    app.notFound((context) => this.#static(context.req.raw));
    this.#route(app, "/health", {
      GET: {
        gate: OPEN_GATE,
        // `pid` — чтобы установка отличила новый процесс от старого
        // (`platform/supervisor-install.md`, шаг 7): версия у них одна.
        handle: () => json({ ok: true, version: VERSION, pid: Deno.pid }),
      },
    });
    this.#route(app, "/rpc", {
      POST: {
        gate: either(keyed(HEADER, [MAIN_KEY, AGENT_KEY]), BY_COOKIE),
        handle: (request) => this.#rpc(request),
      },
    });
    this.#route(app, "/web/session", {
      POST: { gate: OPEN_GATE, handle: (request) => this.#session(request) },
    });
    for (const { path, door, entry } of DOORS) {
      this.#route(app, path, {
        GET: {
          gate: entry(HEADER_OR_PROTOCOL),
          handle: (request, caller) => this.#upgrade(request, door, caller),
        },
        POST: {
          gate: entry(HEADER),
          handle: (request, caller) => this.#post(request, door, caller),
        },
      });
      this.#route(app, `${path}/answer`, {
        POST: {
          gate: entry(HEADER),
          handle: (request, caller) => this.#answer(request, door, caller),
        },
      });
    }
    return app;
  }

  async stop() {
    for (const line of this.#open.keys()) line.stop();
    await Promise.allSettled(this.#open.values());
  }

  /**
   * Путь и его методы. Проверки по порядку: метод (чужой — 405 с
   * `Allow`), `Origin`, токен входа метода.
   */
  #route(
    app: Hono,
    path: string,
    methods: Readonly<Record<string, Handler>>,
  ) {
    const byMethod = new Map(Object.entries(methods));
    const allow = [...byMethod.keys()].join(", ");
    app.all(path, async (context) => {
      const request = context.req.raw;
      const handler = byMethod.get(request.method);
      if (handler === undefined) return empty(405, { Allow: allow });
      const origin = request.headers.get("Origin");
      if (origin !== null && !ORIGINS.allows(origin)) return empty(403);
      const caller = await handler.gate.caller(request, {
        tokens: this.#options.tokens,
        web: this.#options.web,
        origin: this.#origin,
      });
      if (caller === undefined) return empty(401);
      return await handler.handle(request, caller);
    });
  }

  /**
   * Обмен ключа из ссылки `web` на сессию (`specs/web.md`): только со
   * страницы фронта; ключ одноразовый.
   */
  async #session(request: Request): Promise<Response> {
    if (request.headers.get("Origin") !== this.#origin) return empty(403);
    const session = await this.#options.web.exchange(
      keyOf(await request.text()),
    );
    if (session === undefined) return empty(404);
    return empty(204, {
      "Set-Cookie":
        `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; ` +
        `Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }

  /** Статика фронта: без токена, остальное — 404. */
  #static(request: Request): Promise<Response> | Response {
    if (request.method !== "GET") return empty(404);
    return staticFile(this.#options.webRoot, new URL(request.url).pathname);
  }

  async #rpc(request: Request): Promise<Response> {
    const body = answerRpc(await request.text(), this.#methods);
    if (body === undefined) return empty(204);
    return json(body);
  }

  /** WebSocket строки. Подпротокол `bearer.*` в ответ не выбирается. */
  #upgrade(request: Request, door: Door, caller: Caller): Response {
    const chosen = offeredProtocols(request).find((one) =>
      !one.startsWith(BEARER_PROTOCOL)
    );
    let upgraded: { socket: WebSocket; response: Response };
    try {
      upgraded = Deno.upgradeWebSocket(
        request,
        chosen === undefined ? {} : { protocol: chosen },
      );
    } catch (err) {
      // Не запрос подключения WebSocket: отвечать строкой нечему.
      if (!(err instanceof TypeError)) throw err;
      return empty(400);
    }
    const { line, first } = socketLine(upgraded.socket);
    this.#track(line, first, door, caller);
    return upgraded.response;
  }

  /** Строка простым HTTP: тело — первый кадр, ответ — по `Accept`. */
  async #post(request: Request, door: Door, caller: Caller) {
    const form = formFor(request.headers.get("Accept"));
    if (form === undefined) return empty(406);
    const first = await request.text();
    const asking = ticketAsking(this.#tickets, door, caller);
    // Транспорт закрыт вместе с ответом: ждать закрытия нечего.
    const line = new Line(DETACHED, asking, Promise.resolve());
    const opened = form.open(line);
    line.attach(opened.delivery);
    leaving(request, opened);
    this.#track(line, Promise.resolve(first), door, caller);
    return await opened.response;
  }

  /** Ответ на вопрос по номеру: продолжение строки в этом ответе. */
  async #answer(request: Request, door: Door, caller: Caller) {
    const form = formFor(request.headers.get("Accept"));
    if (form === undefined) return empty(406);
    let reply: { readonly ticket: string; readonly answer: string };
    try {
      reply = ticketAnswerOf(await request.text());
    } catch (err) {
      // Контекст пришёл первым запросом и живёт до конца строки; поле
      // здесь — не недействительный номер, а лишнее в теле, и ответ
      // обязан это различать (`platform/call-context.md`).
      if (!(err instanceof BadFrame)) throw err;
      return json({ error: err.report }, 400);
    }
    const line = this.#tickets.take(reply.ticket, door, caller);
    if (line === undefined) {
      return json({ error: "номер подтверждения недействителен" }, 404);
    }
    const opened = form.open(line);
    line.resume(opened.delivery, reply.answer);
    leaving(request, opened);
    return await opened.response;
  }

  /** Строка в работе: её сбой — отказ строки, конец — забыть её. */
  #track(line: Line, first: Promise<unknown>, door: Door, caller: Caller) {
    const task = this.#serveLine(line, first, door, caller)
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.#options.diagnose(`mpu-back: сбой строки: ${reason}`);
        line.finish(1);
      })
      // У сокета строка кончается закрытием, а не кадром `exit`:
      // остановка сервера ждёт его, иначе клиент увидел бы 1001.
      .then(() => line.gone())
      .finally(() => this.#open.delete(line));
    this.#open.set(line, task);
  }

  async #serveLine(
    line: Line,
    first: Promise<unknown>,
    door: Door,
    caller: Caller,
  ) {
    let request: LineRequest;
    try {
      request = lineRequest(await first);
    } catch (err) {
      if (!(err instanceof BadFrame)) throw err;
      line.stderr(`mpu-back: ${err.report}\n`);
      line.finish(2);
      return;
    }
    if (!(await isDirectory(request.cwd))) {
      line.stderr(`mpu-back: нет каталога ${request.cwd}\n`);
      line.finish(2);
      return;
    }
    const channel = door.channel(line, caller.human(request.human));
    const entry = lineEntry({
      rootMethods: door.rootMethods({
        web: this.#options.web,
        origin: this.#origin,
      }),
      file: this.#options.policyFile,
      channel: () => channel,
      execute: (run) => line.execute(run, this.#lines),
    });
    const io = lineIo(
      this.#options.io,
      line,
      door.prompting(caller.human(request.human)),
      request,
    );
    line.finish(
      await runJournaled(request.words, entry, io, this.#options.log, line),
    );
  }
}

/**
 * Поднимает сервер на петле и записывает снимок дерева.
 *
 * @throws Deno.errors.AddrInUse — порт занят
 */
export async function serveBack(options: BackOptions): Promise<RunningBack> {
  const snapshot = {
    version: VERSION,
    nodes: registryNodes(),
    selection: selectionMessages(),
  };
  const back = new Back(options, snapshot);
  const address = Promise.withResolvers<Deno.NetAddr>();
  const server = Deno.serve({
    hostname: LOOPBACK,
    port: options.port,
    onListen: address.resolve,
  }, back.app().fetch);
  const bound = await address.promise;
  back.listening(bound.port);
  const failure = await writeSnapshot(
    options.snapshotFile,
    JSON.stringify(snapshot),
    options.fs ?? DENO_FS,
  );
  if (failure !== undefined) {
    options.diagnose(`mpu-back: снимок дерева не записан: ${failure}`);
  }
  // Остановка одна: повторный вызов ждёт ту же (сигнал может прийти
  // дважды, а второй `shutdown` у сервера Deno бросает).
  let stopping: Promise<void> | undefined;
  return {
    port: bound.port,
    hostname: bound.hostname,
    stop: () =>
      stopping ??= (async () => {
        await back.stop();
        await server.shutdown();
      })(),
  };
}
