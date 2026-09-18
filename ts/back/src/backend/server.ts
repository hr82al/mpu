/**
 * Сервер `mpu-back` (`platform/back-rpc.md`): строки `mpu-next` по
 * WebSocket и запросы без исполнения по HTTP, только на петле. Доступ
 * решается до всего остального: путь, метод, `Origin`, токен.
 */

import { Hono } from "@hono/hono";
import { hasBearer, LOOPBACK, LOOPBACK_ORIGINS } from "../access/mod.ts";
import type { CommandIo, RemoteOutput } from "../command/mod.ts";
import type { Output } from "../entrypoint/mod.ts";
import type { InvokeLog } from "../invokelog/mod.ts";
import { nextEntry, registryNodes, rulesOf } from "../next/mod.ts";
import { runJournaled } from "../process/mod.ts";
import { VERSION } from "../version.ts";
import { AGENT, type Caller, OWNER } from "./caller.ts";
import { AGENT_DOOR, type Door, HUMAN_DOOR } from "./door.ts";
import {
  BadFrame,
  type LineRequest,
  lineRequest,
  ticketAnswerOf,
} from "../frames/mod.ts";
import { formFor, ticketAsking } from "./http.ts";
import { DETACHED, Line } from "./line.ts";
import { socketLine } from "./socket.ts";
import { Tickets } from "./tickets.ts";
import { Serial } from "./queue.ts";
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

/** Вход пути: кто пришёл; не пущен — `undefined`. */
interface Gate {
  caller(request: Request, tokens: Tokens): Caller | undefined;
}

/** Вход по одному из ключей, предъявленному так, как принимает путь. */
function keyed(presentation: Presentation, keys: readonly Key[]): Gate {
  return {
    caller: (request, tokens) =>
      keys.find((key) => presentation.shows(request, key.token(tokens)))
        ?.caller,
  };
}

/** Двери строки: путь, канал и какие ключи пускают. */
const DOORS: readonly {
  readonly path: string;
  readonly door: Door;
  readonly keys: readonly Key[];
}[] = [
  { path: "/line", door: HUMAN_DOOR, keys: [MAIN_KEY] },
  { path: "/agent/line", door: AGENT_DOOR, keys: [MAIN_KEY, AGENT_KEY] },
];

/** Метод пути: его вход и обработка. */
interface Handler {
  readonly gate: Gate;
  handle(request: Request, caller: Caller): Response | Promise<Response>;
}

/** Путь без токена (`/health`). */
const OPEN_GATE: Gate = { caller: () => OWNER };

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

/** Окружение строки: окружение сервера без stdin и без терминалов. */
function lineIo(io: CommandIo, output: Output): CommandIo {
  return {
    ...io,
    readStdin: () => Promise.resolve(new Uint8Array()),
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => false,
    stderrIsTerminal: () => false,
    openTerminal: () => Promise.resolve(undefined),
    openRemoteOutput: () => remoteFrames(output),
  };
}

/** Вывод удалённой команды — кадрами строки, UTF-8 по кускам. */
function remoteFrames(output: Output): RemoteOutput {
  const out = new TextDecoder();
  const err = new TextDecoder();
  const sent = (text: string, send: (text: string) => void) => {
    if (text !== "") send(text);
  };
  return {
    out: (chunk) =>
      sent(out.decode(chunk, { stream: true }), (text) => output.stdout(text)),
    err: (chunk) =>
      sent(err.decode(chunk, { stream: true }), (text) => output.stderr(text)),
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
  readonly #serial = new Serial();
  readonly #tickets: Tickets;
  readonly #open = new Map<Line, Promise<void>>();
  readonly #methods: Methods;

  constructor(options: BackOptions, snapshot: unknown) {
    this.#options = options;
    this.#tickets = new Tickets(options.newTicket);
    this.#methods = new Map<string, () => unknown>([
      ["tree.snapshot", () => snapshot],
      ["policy.list", () => rulesOf(options.policyFile)],
      ["schema", () => SCHEMA],
    ]);
  }

  app(): Hono {
    const app = new Hono();
    app.notFound(() => empty(404));
    this.#route(app, "/health", {
      GET: {
        gate: OPEN_GATE,
        handle: () => json({ ok: true, version: VERSION }),
      },
    });
    this.#route(app, "/rpc", {
      POST: {
        gate: keyed(HEADER, [MAIN_KEY, AGENT_KEY]),
        handle: (request) => this.#rpc(request),
      },
    });
    for (const { path, door, keys } of DOORS) {
      this.#route(app, path, {
        GET: {
          gate: keyed(HEADER_OR_PROTOCOL, keys),
          handle: (request, caller) => this.#upgrade(request, door, caller),
        },
        POST: {
          gate: keyed(HEADER, keys),
          handle: (request, caller) => this.#post(request, door, caller),
        },
      });
      this.#route(app, `${path}/answer`, {
        POST: {
          gate: keyed(HEADER, keys),
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
    app.all(path, (context) => {
      const request = context.req.raw;
      const handler = byMethod.get(request.method);
      if (handler === undefined) return empty(405, { Allow: allow });
      const origin = request.headers.get("Origin");
      if (origin !== null && !ORIGINS.allows(origin)) return empty(403);
      const caller = handler.gate.caller(request, this.#options.tokens);
      if (caller === undefined) return empty(401);
      return handler.handle(request, caller);
    });
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
    this.#track(line, Promise.resolve(first), door, caller);
    return await opened.response;
  }

  /** Ответ на вопрос по номеру: продолжение строки в этом ответе. */
  async #answer(request: Request, door: Door, caller: Caller) {
    const form = formFor(request.headers.get("Accept"));
    if (form === undefined) return empty(406);
    const reply = ticketAnswerOf(await request.text());
    const line = this.#tickets.take(reply.ticket, door, caller);
    if (line === undefined) {
      return json({ error: "номер подтверждения недействителен" }, 404);
    }
    const opened = form.open(line);
    line.resume(opened.delivery, reply.answer);
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
      line.stderr("mpu-back: плохой кадр строки\n");
      line.finish(2);
      return;
    }
    if (!(await isDirectory(request.cwd))) {
      line.stderr(`mpu-back: нет каталога ${request.cwd}\n`);
      line.finish(2);
      return;
    }
    const channel = door.channel(line, caller.human(request.human));
    const entry = nextEntry({
      file: this.#options.policyFile,
      channel: () => channel,
      execute: (run) => line.execute(request.cwd, run, this.#serial),
    });
    const io = lineIo(this.#options.io, line);
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
  const snapshot = { version: VERSION, nodes: registryNodes() };
  const back = new Back(options, snapshot);
  const address = Promise.withResolvers<Deno.NetAddr>();
  const server = Deno.serve({
    hostname: LOOPBACK,
    port: options.port,
    onListen: address.resolve,
  }, back.app().fetch);
  const bound = await address.promise;
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
