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
import { AGENT_DOOR, type Door, HUMAN_DOOR } from "./door.ts";
import { BadFrame, type LineRequest, lineRequest } from "./frame.ts";
import { SocketLine } from "./line.ts";
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
  /** Токен доступа. */
  readonly token: string;
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

/** Чем путь проверяет токен. */
interface Credentials {
  holds(request: Request, token: string): boolean;
}

const HEADER: Credentials = { holds: hasBearer };

/** У WebSocket токен и в подпротоколе: браузер заголовок не задаёт. */
const HEADER_OR_PROTOCOL: Credentials = {
  holds: (request, token) =>
    hasBearer(request, token) ||
    offeredProtocols(request).includes(`${BEARER_PROTOCOL}${token}`),
};

/** Путь без токена (`/health`). */
const OPEN_DOOR: Credentials = { holds: () => true };

function offeredProtocols(request: Request): string[] {
  const header = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  return header.split(",").map((one) => one.trim()).filter((one) => one !== "");
}

function empty(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
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
  readonly #open = new Map<SocketLine, Promise<void>>();
  readonly #methods: Methods;

  constructor(options: BackOptions, snapshot: unknown) {
    this.#options = options;
    this.#methods = new Map<string, () => unknown>([
      ["tree.snapshot", () => snapshot],
      ["policy.list", () => rulesOf(options.policyFile)],
      ["schema", () => SCHEMA],
    ]);
  }

  app(): Hono {
    const app = new Hono();
    app.notFound(() => empty(404));
    this.#route(
      app,
      "/health",
      "GET",
      OPEN_DOOR,
      () => json({ ok: true, version: VERSION }),
    );
    this.#route(app, "/rpc", "POST", HEADER, (request) => this.#rpc(request));
    this.#route(
      app,
      "/line",
      "GET",
      HEADER_OR_PROTOCOL,
      (request) => this.#upgrade(request, HUMAN_DOOR),
    );
    this.#route(
      app,
      "/agent/line",
      "GET",
      HEADER_OR_PROTOCOL,
      (request) => this.#upgrade(request, AGENT_DOOR),
    );
    return app;
  }

  async stop() {
    for (const line of this.#open.keys()) line.stop();
    await Promise.allSettled(this.#open.values());
  }

  /** Путь с проверками доступа по порядку: метод, `Origin`, токен. */
  #route(
    app: Hono,
    path: string,
    method: string,
    credentials: Credentials,
    handle: (request: Request) => Response | Promise<Response>,
  ) {
    app.all(path, (context) => {
      const request = context.req.raw;
      if (request.method !== method) return empty(405, { Allow: method });
      const origin = request.headers.get("Origin");
      if (origin !== null && !ORIGINS.allows(origin)) return empty(403);
      if (!credentials.holds(request, this.#options.token)) return empty(401);
      return handle(request);
    });
  }

  async #rpc(request: Request): Promise<Response> {
    const body = answerRpc(await request.text(), this.#methods);
    if (body === undefined) return empty(204);
    return json(body);
  }

  /** WebSocket строки. Подпротокол `bearer.*` в ответ не выбирается. */
  #upgrade(request: Request, door: Door): Response {
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
    const line = new SocketLine(upgraded.socket);
    const task = this.#serveLine(line, door)
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.#options.diagnose(`mpu-back: сбой строки: ${reason}`);
        line.finish(1);
      })
      // Строка кончается закрытием сокета, а не кадром `exit`: остановка
      // сервера ждёт закрытия, иначе клиент увидел бы 1001 вместо 1000.
      .then(() => line.gone())
      .finally(() => this.#open.delete(line));
    this.#open.set(line, task);
    return upgraded.response;
  }

  async #serveLine(line: SocketLine, door: Door) {
    let request: LineRequest;
    try {
      request = lineRequest(await line.first());
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
    const channel = door.channel(line, request.human);
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
