/**
 * Сервер `mpu-back` (`platform/back-rpc.md`): строки по
 * WebSocket и запросы без исполнения по HTTP, только на петле. Доступ
 * решается до всего остального: путь, метод, `Origin`, токен.
 */

import { stat } from "node:fs/promises";
import process from "node:process";
import { Hono } from "hono";
import { hasBearer, LOOPBACK_ORIGINS } from "@mpu/base/access";
import type { CommandIo, RemoteOutput } from "@mpu/command";
import {
  type InvokeLog,
  type InvokeRecording,
  NO_INVOKE_LOG,
} from "@mpu/invokelog";
import {
  LastResults,
  lineEntry,
  policyTree,
  programFiles,
  protocolMessages,
  registryNodes,
  rulesOf,
  selectionMessages,
} from "../line/mod.ts";
import { runJournaled } from "../process/mod.ts";
import { VERSION } from "../version.ts";
import { Image, ImageError, type ImageMethod } from "../image/mod.ts";
import {
  AGENT,
  BROWSER,
  type Caller,
  cookieOf,
  type Naming,
  OWNER,
  SESSION_COOKIE,
} from "./caller.ts";
import { AGENT_DOOR, type Door, HUMAN_DOOR } from "./door.ts";
import {
  BadFrame,
  CHANNEL_PATH,
  FRAME_INPUT,
  type InputSource,
  type LineRequest,
  lineRequest,
  ticketAnswerOf,
} from "@mpu/language/frames";
import { formFor, type Opened, ticketAsking } from "./http.ts";
import { type Asking, linePrompt, type PromptDoor } from "./prompt.ts";
import { ChatConfirms, ConfirmingLine } from "./confirm.ts";
import { DETACHED, Line } from "./line.ts";
import { type Spill, SPILL_DIR, SPILL_THRESHOLD } from "./outlet.ts";
import { socketLine } from "./socket.ts";
import { type AcceptedSocket, listenLoopback, Upgrades } from "./loopback.ts";
import { Tickets } from "./tickets.ts";
import { staticFile } from "./static.ts";
import { SESSION_TTL_MS, type WebAccess } from "./web.ts";
import { DEFAULT_LINES, Lines } from "./limit.ts";
import {
  callIo,
  DEFAULT_WARM,
  type Launcher,
  type Markers,
  Workers,
} from "../worker/mod.ts";
import { Gallery, PICTURE_LIMIT } from "@mpu/language/picture";
import { type OwnerQuestions, REAL_CLOCK } from "../botquestions/mod.ts";
import {
  DISK_FILES,
  ElicitationDesk,
  NotifyDesk,
  PermissionDesk,
  RUN_TMUX,
  Sessions,
  StopDesk,
  Transcripts,
  Windows,
} from "../claudehook/mod.ts";
import { ChannelConnection } from "./channel.ts";
import { answerRpc, type Methods } from "./rpc.ts";
import SCHEMA from "./schema.json" with { type: "json" };
import { PROCESS_FS, type SnapshotFs, writeSnapshot } from "./snapshot.ts";

/** Окружение службы не читается: строка видит только принесённое. */
const NOT_SERVER = () => undefined;

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
  /** Файл образа (`platform/image.md`); нет HOME — `undefined`. */
  readonly imageFile: string | undefined;
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
  /**
   * Текущее время, мс: память результатов, имена файлов вывода и время
   * определения метода образа; по умолчанию — часы.
   */
  readonly now?: () => number;
  /** Ключи и сессии входа в браузере. */
  readonly web: WebAccess;
  /** Каталог собранного фронта (`$HOME/.local/share/mpu/web`). */
  readonly webRoot: string;
  /**
   * Большой вывод двери агента — файлом (`platform/long-output.md`, §4):
   * каталог и порог; не сказано — `SPILL_DIR` и `SPILL_THRESHOLD`.
   */
  readonly spill?: { readonly dir: string; readonly threshold: number };
  /**
   * Предел суммы байтов картинок одного ответа строки
   * (`platform/picture-frame.md`, «Предел»); не сказано — `PICTURE_LIMIT`.
   */
  readonly pictureLimit?: number;
  /**
   * Вопросы владельцу в Telegram (`platform/telegram-questions.md`):
   * живут весь процесс — старт правит сообщения прошлого запуска и
   * начинает опрос, остановка его прерывает. Ключей бота нет — `NO_BOT`.
   */
  readonly questions: OwnerQuestions;
  /**
   * Окна tmux для подписи вопроса хука `PermissionRequest`; не сказано —
   * настоящий `/usr/bin/tmux`.
   */
  readonly windows?: Windows;
  /**
   * Исполнители строк (`platform/line-executor.md`): как запускать,
   * где отметки сторожа, сколько держать тёплыми (не сказано —
   * `DEFAULT_WARM`).
   */
  readonly workers: {
    readonly launcher: Launcher;
    readonly markers: Markers;
    readonly warm?: number;
  };
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
          presentation.shows(request, key.token(context.tokens)),
        )?.caller,
      ),
  };
}

/** Имя cookie сессии браузера. */
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
  return header
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

/**
 * Апгрейд запроса до WebSocket; сокет получает `use`. Не запрос
 * подключения — 400: отвечать по сокету нечему. Подпротокол `bearer.*` в
 * ответ не выбирается.
 */
function webSocketOf(
  upgrades: Upgrades,
  request: Request,
  use: (socket: AcceptedSocket) => void,
): Response {
  const chosen = offeredProtocols(request).find(
    (one) => !one.startsWith(BEARER_PROTOCOL),
  );
  return upgrades.accept(request, chosen, use) ?? empty(400);
}

function empty(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

/** Номер и ответ из тела запроса с номером. */
type TicketReply = ReturnType<typeof ticketAnswerOf>;

/** Ответ на номер, которого нет (истёк, израсходован, чужой). */
const INVALID_TICKET = { error: "номер подтверждения недействителен" };

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
  asked: Asking,
  door: PromptDoor,
  request: LineRequest,
): CommandIo {
  return {
    ...callIo(io, request.context, request.cwd),
    // Просьба остановиться приходит от клиента, переставшего слушать
    // (`platform/line-cancel.md`).
    signal: line.stopping(),
    // Спрашивает и копирует тот, кто позвал: сервер только просит
    // кадрами (`platform/line-prompt.md`).
    prompt: linePrompt(asked, door),
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
    if (text !== "") send(text);
    // Кадр отдан — ждём, пока клиент его разберёт: иначе вывод
    // быстрой команды копился бы в памяти сервера
    // (`platform/line-cancel.md`). Пустой кусок не шлёт ничего, но
    // готовность ждёт: им её спрашивает вывод программы.
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
    return (await stat(path)).isDirectory();
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
  /** Последние результаты вызывающих (`platform/it.md`). */
  readonly #results: LastResults;
  readonly #methods: Methods;
  /** `http://mpu.localhost:<порт>` — известен, когда сокет слушает. */
  #origin = "";
  /** Куда и с какого размера вывод двери агента уходит файлом. */
  readonly #spill: Spill;
  /** Пул исполнителей: на них идёт каждая команда строки. */
  readonly #workers: Workers;
  /**
   * Образ на весь процесс: сверка `data_version` видит методы, которые
   * определил другой процесс, следующей строкой.
   */
  readonly #image: Image;
  /** Снимок дерева: пересобирается, когда меняется образ. */
  #snapshot: unknown;
  /** Часы сервера: память результатов и время образа. */
  readonly #now: () => number;
  /** Вопросы хука `PermissionRequest`: ряд у них общий с ядром. */
  readonly #desk: PermissionDesk;
  /** Вопросы «ждёт ввода» хука `Stop`: живут дольше своих строк. */
  readonly #stopDesk: StopDesk;
  /** Снимки окон хука `Notification`: живут дольше своих строк. */
  readonly #notifyDesk: NotifyDesk;
  /** Открытые соединения каналов: их закрывает остановка ядра. */
  readonly #channels = new Set<AcceptedSocket>();
  /** Запросы, пришедшие апгрейдом, и принятые из них сокеты. */
  readonly #upgrades: Upgrades;
  /** Сессии Claude Code по ключу: вопрос «ждёт ввода» каждой. */
  readonly #sessions = new Sessions(REAL_CLOCK);
  /** Окна tmux: подпись вопросов в чате владельца. */
  readonly #windows: Windows;
  /** Формы MCP-серверов хука `Elicitation`. */
  readonly #elicitationDesk: ElicitationDesk;

  constructor(options: BackOptions, upgrades: Upgrades) {
    this.#options = options;
    this.#upgrades = upgrades;
    this.#now = options.now ?? Date.now;
    this.#image = Image.at(options.imageFile);
    this.#snapshot = snapshotOf(this.#imageMethods());
    this.#spill = {
      dir: options.spill?.dir ?? SPILL_DIR,
      threshold: options.spill?.threshold ?? SPILL_THRESHOLD,
      now: this.#now,
      diagnose: options.diagnose,
    };
    const lines = options.lines ?? DEFAULT_LINES;
    this.#lines = new Lines(lines);
    this.#workers = new Workers({
      launcher: options.workers.launcher,
      markers: options.workers.markers,
      warm: options.workers.warm ?? DEFAULT_WARM,
      limit: lines,
      diagnose: options.diagnose,
    });
    this.#tickets = new Tickets(options.newTicket);
    const transcripts = new Transcripts({
      files: DISK_FILES,
      clock: REAL_CLOCK,
    });
    const windows = options.windows ?? new Windows(RUN_TMUX);
    this.#windows = windows;
    this.#desk = new PermissionDesk({
      questions: options.questions,
      transcripts,
      windows,
      sessions: this.#sessions,
      clock: REAL_CLOCK,
    });
    this.#notifyDesk = new NotifyDesk({
      questions: options.questions,
      transcripts,
      windows,
      sessions: this.#sessions,
      clock: REAL_CLOCK,
      diagnose: options.diagnose,
    });
    this.#elicitationDesk = new ElicitationDesk({
      questions: options.questions,
      transcripts,
      windows,
      sessions: this.#sessions,
      clock: REAL_CLOCK,
      diagnose: options.diagnose,
    });
    this.#stopDesk = new StopDesk({
      questions: options.questions,
      transcripts,
      windows,
      sessions: this.#sessions,
      diagnose: options.diagnose,
    });
    this.#results = new LastResults(this.#now);
    this.#methods = new Map<string, () => unknown>([
      ["tree.snapshot", () => this.#snapshot],
      ["policy.list", () => rulesOf(options.policyFile)],
      [
        "policy.tree",
        () => policyTree(options.policyFile, this.#imageMethods()),
      ],
      ["schema", () => SCHEMA],
    ]);
  }

  /**
   * Методы образа для снимка и дерева web. Нечитаемый образ — без
   * методов: строки отказывают сами, а снимок нужен дополнению и без них.
   */
  #imageMethods(): readonly ImageMethod[] {
    try {
      return this.#image.methods();
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      this.#options.diagnose(`mpu-back: ${err.message}`);
      return [];
    }
  }

  /** Пересобирает снимок дерева по образу и пишет его на диск. */
  async writeSnapshot() {
    this.#snapshot = snapshotOf(this.#imageMethods());
    const failure = await writeSnapshot(
      this.#options.snapshotFile,
      JSON.stringify(this.#snapshot),
      this.#options.fs ?? PROCESS_FS,
    );
    if (failure !== undefined) {
      this.#options.diagnose(`mpu-back: снимок дерева не записан: ${failure}`);
    }
  }

  /**
   * Сокет слушает порт `port`: адрес страницы фронта известен. Вопросы
   * владельцу стартуют только здесь: процесс, не занявший порт, не
   * должен ни опрашивать бота, ни править в «истёк» сообщения живого
   * соседа по общей кэш-БД.
   */
  listening(port: number) {
    this.#origin = `http://mpu.localhost:${port}`;
    this.#options.questions.start();
  }

  app(): Hono {
    const app = new Hono();
    app.notFound((context) => this.#static(context.req.raw));
    this.#route(app, "/health", {
      GET: {
        gate: OPEN_GATE,
        // `pid` — чтобы установка отличила новый процесс от старого
        // (`platform/supervisor-install.md`, шаг 7): версия у них одна.
        handle: () => json({ ok: true, version: VERSION, pid: process.pid }),
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
    this.#route(app, CHANNEL_PATH, {
      GET: {
        // Канал запускает Claude Code от имени владельца: дверь — его.
        gate: keyed(HEADER_OR_PROTOCOL, [MAIN_KEY]),
        handle: (request) =>
          webSocketOf(this.#upgrades, request, (socket) =>
            this.#channel(socket),
          ),
      },
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
      this.#route(app, `${path}/settled`, {
        POST: {
          gate: entry(HEADER),
          handle: (request, caller) => this.#settled(request, door, caller),
        },
      });
    }
    return app;
  }

  /** Тёплые исполнители — до первой строки. */
  start() {
    this.#workers.start();
  }

  async stop() {
    for (const line of this.#open.keys()) line.stop();
    // Строка, ждущая владельца (хуки `PermissionRequest`, `Elicitation`),
    // иначе держала бы остановку до своего срока: её вопрос — в исход
    // «истёк».
    this.#desk.stop();
    this.#elicitationDesk.stop();
    // Исполнители — до ожидания строк: строка ждёт итога своего
    // исполнителя, и без `stop` ему остановка сервера дождалась бы
    // конца команды.
    const workers = this.#workers.stop();
    await Promise.allSettled(this.#open.values());
    await workers;
    // Вопросы «ждёт ввода» строк не держат: их снимает в «истёк» стол,
    // дождавшись своих наблюдателей.
    await this.#stopDesk.stop();
    await this.#notifyDesk.stop();
    // Каналы — после стола: их вопросы уже «истёк», и закрытие соединения
    // («сессия закрыта») решённое не перерешит.
    for (const socket of this.#channels) socket.close();
    // После строк: строка, ждавшая вопрос, при остановке снимает его,
    // и правка сообщения в «истёк» должна успеть уйти.
    await this.#options.questions.stop();
    this.#image[Symbol.dispose]();
  }

  /**
   * Путь и его методы. Проверки по порядку: метод (чужой — 405 с
   * `Allow`), `Origin`, токен входа метода.
   */
  #route(app: Hono, path: string, methods: Readonly<Record<string, Handler>>) {
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

  /**
   * Соединение канала Claude Code (`claude-channel.md`, «Регистрация в
   * ядре»): кадры и закрытие — соединению; открытые закрывает остановка.
   */
  #channel(socket: AcceptedSocket): void {
    const connection = new ChannelConnection(this.#sessions, {
      send: (frame) => {
        if (!socket.isOpen()) return false;
        socket.send(frame);
        return true;
      },
      close: () => socket.close(),
    });
    this.#channels.add(socket);
    socket.onMessage((data) => connection.heard(String(data)));
    socket.onClose(() => {
      this.#channels.delete(socket);
      connection.closed();
    });
  }

  /** WebSocket строки. */
  #upgrade(request: Request, door: Door, caller: Caller): Response {
    // После апгрейда запрос закрыт: имя вызывающего — до него.
    const naming = caller.naming(request);
    return webSocketOf(this.#upgrades, request, (socket) => {
      const { line, first, input } = socketLine(socket);
      this.#track(line, first, input, door, caller, naming);
    });
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
    this.#track(
      line,
      Promise.resolve(first),
      // Спросить ввод простым HTTP нечем: он приходит полем тела.
      FRAME_INPUT,
      door,
      caller,
      caller.naming(request),
    );
    return await opened.response;
  }

  /** Ответ на вопрос по номеру: продолжение строки в этом ответе. */
  #answer(request: Request, door: Door, caller: Caller) {
    const form = formFor(request.headers.get("Accept"));
    if (form === undefined) return empty(406);
    return this.#byTicket(request, async (reply) => {
      const claim = this.#tickets.take(reply.ticket, door, caller);
      if (claim === undefined) return json(INVALID_TICKET, 404);
      const opened = form.open(claim.line);
      claim.line.resume(opened.delivery, claim.answer(reply.answer));
      leaving(request, opened);
      return await opened.response;
    });
  }

  /**
   * Ожидание решения в другом месте по номеру (`platform/ask-telegram.md`
   * [D.3]): решено — сразу `{"settled": "<текст>"}`, строка ждёт ответа по
   * номеру и продолжится с решённым ответом; номер отозван (ответ пришёл,
   * срок вышел) или клиент ушёл раньше — 404. Строку запрос не трогает:
   * его обрыв — не уход клиента строки.
   */
  #settled(request: Request, door: Door, caller: Caller) {
    return this.#byTicket(request, async (reply) => {
      const claim = this.#tickets.take(reply.ticket, door, caller);
      if (claim === undefined) return json(INVALID_TICKET, 404);
      const settlement = await claim.settled(request.signal);
      return settlement.read({
        decided: (said) => json({ settled: said }),
        gone: () => json(INVALID_TICKET, 404),
      });
    });
  }

  /** Запрос с номером: тело — номер и ответ. */
  async #byTicket(
    request: Request,
    then: (reply: TicketReply) => Promise<Response>,
  ): Promise<Response> {
    let reply: TicketReply;
    try {
      reply = ticketAnswerOf(await request.text());
    } catch (err) {
      // Контекст пришёл первым запросом и живёт до конца строки; поле
      // здесь — не недействительный номер, а лишнее в теле, и ответ
      // обязан это различать (`platform/call-context.md`).
      if (!(err instanceof BadFrame)) throw err;
      return json({ error: err.report }, 400);
    }
    return await then(reply);
  }

  /** Строка в работе: её сбой — отказ строки, конец — забыть её. */
  #track(
    line: Line,
    first: Promise<unknown>,
    input: InputSource,
    door: Door,
    caller: Caller,
    naming: Naming,
  ) {
    const task = this.#serveLine(line, first, input, door, caller, naming)
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
    input: InputSource,
    door: Door,
    caller: Caller,
    naming: Naming,
  ) {
    let request: LineRequest;
    try {
      request = lineRequest(await first, input);
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
    // Окно tmux и ключ сессии — только из окружения, принесённого
    // клиентом: имя, не принесённое им, у службы своё и подписало бы
    // вопрос чужим окном.
    const callerEnv = (name: string) =>
      request.context.env.over(NOT_SERVER).value(name);
    const asked = new ConfirmingLine(
      line,
      new ChatConfirms({
        questions: this.#options.questions,
        windows: this.#windows,
        env: callerEnv,
        sessions: this.#sessions,
        head: door.confirmHead,
      }),
    );
    const channel = door.channel(asked, caller.human(request.human));
    const memory = this.#results.of(await naming.of(request.caller));
    const gallery = new Gallery(this.#options.pictureLimit ?? PICTURE_LIMIT);
    const entry = lineEntry({
      files: programFiles(this.#options.io.env),
      rootMethods: door.rootMethods({
        web: this.#options.web,
        origin: this.#origin,
      }),
      file: this.#options.policyFile,
      channel: () => channel,
      execute: (run) => line.execute(run, this.#lines),
      invoker: this.#workers,
      evaluator: this.#workers,
      memory,
      refusal: (data) => line.deliver({ refusal: data }),
      pictures: gallery,
      owner: {
        permission: (text, signal) => this.#desk.reply(text, callerEnv, signal),
        stop: (text) => this.#stopDesk.reply(text, callerEnv),
        notification: (text) => this.#notifyDesk.reply(text, callerEnv),
        elicitation: (text, signal) =>
          this.#elicitationDesk.reply(text, callerEnv, signal),
      },
      image: {
        image: this.#image,
        author: caller.author(door.author),
        now: () => new Date(this.#now()),
        changed: () => this.writeSnapshot(),
      },
    });
    const io = lineIo(
      this.#options.io,
      line,
      asked,
      door.prompting(caller.human(request.human)),
      request,
    );
    // Имя записи журнала — оно же имя файла большого вывода; спрашивается
    // после исполнения, когда pid исполнителя в нём уже свой.
    let recorded: InvokeRecording = NO_INVOKE_LOG.begin({
      kind: "argv",
      argv: [],
      cwd: "",
    });
    const log: InvokeLog = {
      begin: (command) => (recorded = this.#options.log.begin(command)),
    };
    const code = await runJournaled(request.words, entry, io, log, line);
    line.ran(
      door.outlet(this.#spill, {
        runId: recorded.runId(),
        sliced: memory.sliced(),
      }),
    );
    // Кадры картинок — перед `exit`, а не по ходу: строка с итогом ≠ 0 не
    // выпускает ни одной, даже от своей успешной команды ([D.3]).
    for (const picture of await gallery.frames(code)) line.deliver({ picture });
    line.finish(code);
  }
}

/** Снимок дерева: версия, узлы с методами образа, сообщения отбора. */
function snapshotOf(image: readonly ImageMethod[]) {
  return {
    version: VERSION,
    nodes: registryNodes(image),
    selection: selectionMessages(),
    protocol: protocolMessages(),
  };
}

/**
 * Поднимает сервер на петле и записывает снимок дерева.
 *
 * @throws Error с `code === "EADDRINUSE"` — порт занят
 */
export async function serveBack(options: BackOptions): Promise<RunningBack> {
  const upgrades = new Upgrades();
  const back = new Back(options, upgrades);
  // Исполнители — после привязки порта: процесс, не ставший сервером
  // (порт занят), не должен оставить за собой запущенных исполнителей.
  const server = await listenLoopback({
    port: options.port,
    fetch: back.app().fetch,
    upgrades,
  });
  back.start();
  back.listening(server.port);
  await back.writeSnapshot();
  // Остановка одна: повторный вызов ждёт ту же (сигнал может прийти
  // дважды, а второй `close` у сервера бросает).
  let stopping: Promise<void> | undefined;
  return {
    port: server.port,
    hostname: server.hostname,
    stop: () =>
      (stopping ??= (async () => {
        await back.stop();
        await server.stop();
      })()),
  };
}
