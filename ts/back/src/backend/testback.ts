/**
 * Сервер `mpu-back` для тестов: порт от ОС, токен, файл правил и снимок
 * во временном каталоге. Всё, что сервер отдал наружу — кадры, ответы
 * HTTP, заголовки, диагностика, — копится и при остановке проверяется
 * на отсутствие токена (`platform/back-rpc.md`, инвариант о токене).
 */

import { assert, assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeLog } from "../invokelog/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { secretText } from "../runtime/mod.ts";
import { type RunningBack, serveBack, type SnapshotFs } from "./mod.ts";
import { WebAccess } from "./web.ts";
import { MarkerDir, MemoryLauncher } from "../worker/mod.ts";

/** Кадр сервера как его получил клиент. */
export type Frame = Readonly<Record<string, unknown>>;

/** Кадр отказа без подсказки и ближайших (`platform/refusal-object.md`). */
export function refusalFrame(reason: string, text: string): Frame {
  return { refusal: { reason, hint: null, candidates: [], text } };
}

/** Поднятый для теста сервер. */
export interface TestBack {
  readonly url: string;
  readonly token: string;
  readonly agentToken: string;
  readonly policyFile: string;
  readonly snapshotFile: string;
  /** Файл сессий браузера. */
  readonly webSessions: string;
  /** Пути команд, дошедших до исполнения, по порядку. */
  readonly called: string[];
  /** Каталоги, названные записями журнала, по порядку начала записи. */
  readonly dirs: string[];
  /** Строки диагностики сервера. */
  readonly diagnosed: string[];
  /** Всё, что сервер отдал наружу, — для поиска токена. */
  readonly seen: string[];
  /** Всё, что увидел журнал вызовов, — для поиска чужих секретов. */
  readonly logged: string[];
  /** Каталог файлов большого вывода — во временном каталоге теста. */
  readonly spillDir: string;
  /** Исполнители строк сервера — в памяти теста. */
  readonly launcher: MemoryLauncher;
  /** pid исполнителей, названные записями журнала, по порядку. */
  readonly executors: number[];
  /** Каталог отметок сторожа (`platform/line-executor.md`). */
  readonly markersDir: string;
  readonly running: RunningBack;
}

export interface BackSetup {
  readonly io?: Partial<CommandIo>;
  readonly fs?: SnapshotFs;
  /** Путь снимка; по умолчанию — во временном каталоге. */
  readonly snapshotFile?: (dir: string) => string;
  /** Строка начала запись журнала: разбор и правила — дальше. */
  readonly begun?: (words: readonly string[]) => void;
  /** Предел одновременности строк; не сказано — умолчание сервера. */
  readonly lines?: number;
  /** Завершение записи журнала — после вывода строки, до кадра `exit`. */
  readonly finished?: () => Promise<void>;
  /** Код, которым закрылась запись журнала: по вызову на запись. */
  readonly finishedWith?: (code: number) => void;
  /** Генератор номера подтверждения. */
  readonly newTicket?: () => string;
  /** Каталог фронта; по умолчанию — несуществующий. */
  readonly webRoot?: (dir: string) => string;
  /** Порог вывода двери агента в байтах; по умолчанию — сервера. */
  readonly spillThreshold?: number;
}

const TOKEN = "t0ken-" + "s3cret-" + "value";
const AGENT_TOKEN = "ag3nt-" + "t0ken-" + "value";

/** pid первого исполнителя в памяти: заведомо не pid процесса теста. */
export const FIRST_WORKER_PID = 900_001;

function recordingLog(
  executors: number[],
  called: string[],
  logged: string[],
  dirs: string[],
  begun: (words: readonly string[]) => void,
  finished: (code: number) => Promise<void>,
): InvokeLog {
  let runs = 0;
  return {
    begin: (command) => {
      const argv = "argv" in command ? command.argv : [];
      // Номер записи по порядку: имя файла большого вывода предсказуемо.
      const runId = `run-${++runs}`;
      logged.push(JSON.stringify(argv));
      dirs.push(command.cwd);
      begun(argv);
      // Запись попадает в файл только у помеченного вызова
      // (`platform/invoke-log.md`), и копия ведёт себя так же: код
      // закрытия виден тесту лишь у тех строк, чья запись пишется.
      let marked = false;
      return ({
        runId: () => runId,
        executedBy: (pid: number) => void executors.push(pid),
        nativeCall: (command) => {
          marked = true;
          called.push(command.path.join(" "));
        },
        // Приёмник вывода журнала: печатаемое строкой проходит через
        // него, и копия его видит.
        capture: (output) => ({
          stdout: (text: string) => {
            logged.push(text);
            output.stdout(text);
          },
          stderr: (text: string) => {
            logged.push(text);
            output.stderr(text);
          },
        }),
        out: (text: string) => void logged.push(text),
        err: (text: string) => void logged.push(text),
        note: (text: string) => void logged.push(text),
        finish: (code: number) => marked ? finished(code) : Promise.resolve(),
      });
    },
  };
}

/**
 * Сервер на время `body`; остановка и проверка токена — после.
 * Каталог процесса строки не трогают (`platform/line-concurrency.md`),
 * возвращать его незачем.
 */
export async function withBack(
  body: (back: TestBack) => Promise<void>,
  setup: BackSetup = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const called: string[] = [];
  const executors: number[] = [];
  const logged: string[] = [];
  const dirs: string[] = [];
  const diagnosed: string[] = [];
  const snapshotFile = setup.snapshotFile?.(dir) ?? `${dir}/cache/tree.json`;
  const io = makeFakeIo(setup.io ?? {});
  // Исполнители — в памяти: тот же протокол кадров, что у процесса
  // (`platform/line-executor.md`), без порождения процессов.
  const launcher = new MemoryLauncher(io, FIRST_WORKER_PID, () => Date.now());
  const markers = new MarkerDir(`${dir}/killed`);
  const running = await serveBack({
    port: 0,
    lines: setup.lines,
    tokens: { main: TOKEN, agent: AGENT_TOKEN },
    policyFile: `${dir}/policy.db`,
    io,
    log: recordingLog(
      executors,
      called,
      logged,
      dirs,
      setup.begun ?? (() => {}),
      (code: number) => {
        setup.finishedWith?.(code);
        return setup.finished?.() ?? Promise.resolve();
      },
    ),
    snapshotFile,
    diagnose: (line) => void diagnosed.push(line),
    fs: setup.fs,
    newTicket: setup.newTicket,
    web: await WebAccess.open({
      file: secretText(`${dir}/web-sessions`),
      now: () => Date.now(),
    }),
    webRoot: setup.webRoot?.(dir) ?? `${dir}/web`,
    // Не `/tmp/mpu-out`: тест не пишет туда, где читают живые агенты.
    spill: {
      dir: `${dir}/mpu-out`,
      threshold: setup.spillThreshold ?? 64 * 1024,
    },
    workers: { launcher, markers },
  });
  const back: TestBack = {
    url: `http://127.0.0.1:${running.port}`,
    token: TOKEN,
    agentToken: AGENT_TOKEN,
    policyFile: `${dir}/policy.db`,
    snapshotFile,
    webSessions: `${dir}/web-sessions`,
    called,
    logged,
    dirs,
    diagnosed,
    seen: [],
    spillDir: `${dir}/mpu-out`,
    launcher,
    executors,
    markersDir: `${dir}/killed`,
    running,
  };
  try {
    await body(back);
  } finally {
    // Повисшее исполнение держало бы остановку вечно: тест краснеет.
    await within(running.stop(), 10_000, "остановка сервера");
    await Deno.remove(dir, { recursive: true });
  }
  for (const text of [...back.seen, ...diagnosed]) {
    assert(!text.includes(TOKEN), `токен в выводе: ${text}`);
    assert(!text.includes(AGENT_TOKEN), `агентский токен в выводе: ${text}`);
  }
}

/** Запрос HTTP к серверу; тело и заголовки ответа — в `seen`. */
export async function request(
  back: TestBack,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${back.url}${path}`, init);
  const body = await response.text();
  back.seen.push(body, JSON.stringify([...response.headers]));
  return { status: response.status, body };
}

/** Клиент строки по WebSocket. */
export class Client {
  readonly frames: Frame[] = [];
  readonly #socket: WebSocket;
  readonly #answers: string[];
  readonly #opened = Promise.withResolvers<void>();
  readonly #closed = Promise.withResolvers<number>();
  #listeners: (() => void)[] = [];
  #isClosed = false;

  constructor(
    back: TestBack,
    path: string,
    options: {
      readonly headers?: HeadersInit;
      readonly bearer?: boolean;
      /** Предъявить агентский токен вместо основного. */
      readonly agent?: boolean;
      /** Ответы на кадры `ask` по очереди; кончились — вопрос без ответа. */
      readonly answers?: readonly string[];
      /** Ввод на каждый кадр `stdinRequest`; нет — запрос без ответа. */
      readonly stdin?: string;
    } = {},
  ) {
    this.#answers = [...options.answers ?? []];
    const stdin = options.stdin;
    const protocols = options.bearer === false
      ? ["mpu"]
      : ["mpu", `bearer.${options.agent ? back.agentToken : back.token}`];
    this.#socket = new WebSocket(`${back.url.replace("http", "ws")}${path}`, {
      protocols,
      headers: options.headers,
    });
    this.#socket.onopen = () => {
      back.seen.push(this.#socket.protocol);
      this.#opened.resolve();
    };
    this.#socket.onmessage = (event) => {
      back.seen.push(String(event.data));
      const frame = JSON.parse(String(event.data));
      this.frames.push(frame);
      if ("ask" in frame && this.#answers.length > 0) {
        this.answer(this.#answers.shift() ?? "");
      }
      if ("stdinRequest" in frame && stdin !== undefined) {
        this.send({ stdin });
      }
      this.#notify();
    };
    this.#socket.onerror = () => {};
    this.#socket.onclose = (event) => {
      this.#isClosed = true;
      this.#opened.resolve();
      this.#closed.resolve(event.code);
      this.#notify();
    };
  }

  /** Подключение открыто (или закрылось, не открывшись). */
  opened(): Promise<void> {
    return this.#opened.promise;
  }

  /** Подпротокол, выбранный сервером. */
  protocol(): string {
    return this.#socket.protocol;
  }

  answer(text: string) {
    this.send({ answer: text });
  }

  send(frame: unknown) {
    this.#socket.send(
      typeof frame === "string" ? frame : JSON.stringify(frame),
    );
  }

  /** Первый кадр строки: слова, каталог процесса теста, человек. */
  start(words: readonly string[], human = true) {
    this.send({ words, cwd: Deno.cwd(), human });
  }

  close() {
    this.#socket.close();
  }

  /** Код закрытия сокета. */
  closed(): Promise<number> {
    return this.#closed.promise;
  }

  /** Ждёт кадр, удовлетворяющий условию. */
  async frame(match: (frame: Frame) => boolean): Promise<Frame> {
    while (true) {
      const found = this.frames.find(match);
      if (found !== undefined) return found;
      if (this.#isClosed) throw new Error("сокет закрыт, кадра не было");
      const next = Promise.withResolvers<void>();
      this.#listeners.push(next.resolve);
      await next.promise;
    }
  }

  /** Ждёт кадр `exit` и закрытие; отдаёт все кадры. */
  async finished(): Promise<Frame[]> {
    await this.frame((frame) => "exit" in frame);
    assertEquals(await this.closed(), 1000);
    return [...this.frames];
  }

  #notify() {
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) listener();
  }
}

/** Строка целиком: подключение, первый кадр, ответы, кадры до `exit`. */
export async function line(
  back: TestBack,
  path: string,
  words: readonly string[],
  answers: readonly string[] = [],
  human = true,
): Promise<Frame[]> {
  const client = new Client(back, path, { answers });
  await client.opened();
  client.start(words, human);
  return await client.finished();
}

/**
 * Промис или отказ через `ms` миллисекунд. Не синхронизация, а сторож:
 * тест, чьё ожидание не наступит никогда, краснеет, а не висит.
 */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  const watchdog = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => watchdog.reject(new Error(`не дождались: ${what}`)),
    ms,
  );
  try {
    return await Promise.race([promise, watchdog.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Запрос строки простым HTTP. */
export interface Post {
  readonly accept?: string;
  /** Предъявить агентский токен вместо основного. */
  readonly agent?: boolean;
  readonly signal?: AbortSignal;
}

/** `POST` к серверу с токеном заголовком; тело — как есть или JSON. */
export function post(
  back: TestBack,
  path: string,
  body: unknown,
  options: Post = {},
): Promise<Response> {
  const token = options.agent ? back.agentToken : back.token;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.accept !== undefined) headers.Accept = options.accept;
  return fetch(`${back.url}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
}

/** Тело ответа целиком (в `seen`) — кадры NDJSON. */
export async function ndjson(back: TestBack, response: Response) {
  const text = await response.text();
  back.seen.push(text, JSON.stringify([...response.headers]));
  return text.split("\n").filter((row) => row !== "").map((row) =>
    JSON.parse(row) as Frame
  );
}

/** Тело ответа целиком (в `seen`) — один объект JSON. */
export async function collected(back: TestBack, response: Response) {
  const text = await response.text();
  back.seen.push(text, JSON.stringify([...response.headers]));
  return JSON.parse(text) as Frame;
}

/**
 * Строка простым HTTP целиком: ответы по очереди, пока строка
 * кончается вопросом и ответы есть.
 */
export async function httpLine(
  back: TestBack,
  path: string,
  body: unknown,
  answers: readonly string[] = [],
  options: Post = {},
): Promise<Frame[][]> {
  const responses = [await ndjson(back, await post(back, path, body, options))];
  for (const answer of answers) {
    const last = responses.at(-1)?.at(-1);
    if (last === undefined || !("ticket" in last)) break;
    responses.push(
      await ndjson(
        back,
        await post(
          back,
          `${path}/answer`,
          { ticket: last.ticket, answer },
          options,
        ),
      ),
    );
  }
  return responses;
}
