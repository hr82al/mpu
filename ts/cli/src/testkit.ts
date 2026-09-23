/**
 * Для тестов клиента: окружение с подменами и записывающий сервер,
 * который видит дверь, токен и первый кадр и отвечает кадрами сценария.
 */

import type { TerminalIo } from "./terminal/mod.ts";
import type { ClientEnv } from "./client.ts";

/** Окружение клиента и то, что он напечатал. */
export interface TestEnv {
  readonly env: ClientEnv;
  readonly stdout: string[];
  readonly stderr: string[];
  /** Тексты, которые клиент положил в буфер обмена. */
  readonly copied: string[];
  /** Вопросы, заданные терминалу: вид и текст. */
  readonly asked: { kind: "line" | "secret"; question: string }[];
  /** Сколько раз клиент читал свой stdin. */
  readonly stdinReads: () => number;
  readonly interrupt: () => void;
}

export interface EnvSetup {
  readonly base: string;
  readonly main?: string;
  readonly agent?: string;
  /** И stdin, и stderr — терминалы: есть кого спросить. */
  readonly terminals?: boolean;
  /** Строки stdin по очереди; кончились — конец ввода. */
  readonly answers?: readonly string[];
  /** Весь stdin клиента; из терминала ввода нет (`cli-client.md`). */
  readonly stdin?: string;
  /**
   * Чтение stdin вместо `stdin`: например, открытый канал без писателя,
   * чтение которого не кончается никогда.
   */
  readonly readStdin?: () => Promise<string>;
  /** Терминал ли stdout и какая у него ширина. */
  readonly stdout?: boolean;
  readonly columns?: number;
  /** Как клиент называет себя; по умолчанию — `ppid:1`. */
  readonly name?: string;
  /** Удаётся ли копирование в буфер обмена. */
  readonly clipboard?: boolean;
  /** Копирование ждёт этого промиса: проверка, что клиент его дождётся. */
  readonly copying?: Promise<void>;
  /** Переменные окружения клиента. */
  readonly values?: Readonly<Record<string, string>>;
}

/** Подставной управляющий терминал: вопросы и заготовленные ответы. */
function fakeTerminal(
  answers: string[],
  asked: { kind: "line" | "secret"; question: string }[],
): TerminalIo {
  let kind: "line" | "secret" = "line";
  return {
    name: undefined,
    write: (text) => {
      asked.push({ kind, question: text });
      return Promise.resolve();
    },
    readLine: () => {
      kind = "line";
      asked[asked.length - 1] = { ...asked[asked.length - 1], kind };
      return Promise.resolve(answers.shift());
    },
    readSecret: () => {
      kind = "secret";
      asked[asked.length - 1] = { ...asked[asked.length - 1], kind };
      return Promise.resolve(answers.shift());
    },
    [Symbol.dispose]: () => {},
  };
}

export function testEnv(setup: EnvSetup): TestEnv {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const copied: string[] = [];
  const asked: { kind: "line" | "secret"; question: string }[] = [];
  const answers = [...setup.answers ?? []];
  const terminals = setup.terminals ?? false;
  const interrupted = Promise.withResolvers<void>();
  const readStdin = setup.readStdin ??
    (() => Promise.resolve(setup.stdin ?? ""));
  let stdinReads = 0;
  return {
    stdout,
    stderr,
    copied,
    asked,
    stdinReads: () => stdinReads,
    interrupt: () => interrupted.resolve(),
    env: {
      base: setup.base,
      mainTokenPath: "/home/test/.config/mpu/token",
      mainToken: () => Promise.resolve(setup.main),
      agentToken: () => Promise.resolve(setup.agent),
      caller: {
        stdin: () => {
          stdinReads += 1;
          return readStdin();
        },
        stdinIsTerminal: () => terminals,
        stdoutIsTerminal: () => setup.stdout ?? false,
        stderrIsTerminal: () => terminals,
        columns: () => setup.columns,
        value: (name) => setup.values?.[name],
      },
      name: setup.name ?? "ppid:1",
      openTerminal: () =>
        Promise.resolve(terminals ? fakeTerminal(answers, asked) : undefined),
      copy: async (text) => {
        await setup.copying;
        copied.push(text);
        return setup.clipboard ?? true;
      },
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      cwd: () => Deno.cwd(),
      interrupted: interrupted.promise,
    },
  };
}

/** Что увидел записывающий сервер. */
export interface Visit {
  readonly path: string;
  /** Заголовок `Authorization` или подпротокол `bearer.*` — токен без обёрток. */
  readonly token: string;
  readonly first: Record<string, unknown>;
  readonly answers: string[];
  /** Кадры `stdin` клиента по порядку. */
  readonly inputs: string[];
}

/** Сценарий сервера: что ответить на строку. */
export type Script = (
  socket: WebSocket,
  first: Record<string, unknown>,
  answers: AsyncIterable<string>,
  inputs: AsyncIterable<string>,
) => Promise<void>;

/**
 * Промис или отказ через `ms` миллисекунд. Не синхронизация, а сторож:
 * тест, чьё ожидание не наступит никогда, краснеет, а не висит. Тот же
 * приём, что у тестов сервера: импортировать их подпроекту `cli/`
 * нельзя.
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

/** Отвечает кадром `exit 0`. */
export const EXIT_ZERO: Script = (socket) => {
  socket.send(JSON.stringify({ exit: 0 }));
  socket.close(1000);
  return Promise.resolve();
};

function tokenOf(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",").map((one) => one.trim());
  return offered.find((one) => one.startsWith("bearer."))
    ?.slice("bearer.".length) ?? "";
}

/** Очередь ответов клиента для сценария. */
class Answers implements AsyncIterable<string> {
  readonly #queue: string[] = [];
  #wake: () => void = () => {};

  push(answer: string) {
    this.#queue.push(answer);
    this.#wake();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      const woken = Promise.withResolvers<void>();
      this.#wake = woken.resolve;
      await woken.promise;
    }
  }
}

/**
 * Записывающий сервер на время `body`.
 *
 * @param status ответ на обычный GET к двери (400 — доступ есть)
 * @param script сценарий строки
 */
export async function withFakeServer(
  body: (base: string, visits: Visit[]) => Promise<void>,
  options: { readonly status?: number; readonly script?: Script } = {},
): Promise<void> {
  const visits: Visit[] = [];
  const scripts: Promise<void>[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (
    request,
  ) => {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: options.status ?? 400 });
    }
    // Заголовки — до upgrade: после него запрос закрыт.
    const visit: Visit = {
      path: new URL(request.url).pathname,
      token: tokenOf(request),
      first: {},
      answers: [],
      inputs: [],
    };
    const { socket, response } = Deno.upgradeWebSocket(request, {
      protocol: "mpu",
    });
    const answers = new Answers();
    const inputs = new Answers();
    const started = Promise.withResolvers<void>();
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (visits.includes(visit) && "stdin" in frame) {
        visit.inputs.push(frame.stdin);
        inputs.push(frame.stdin);
        return;
      }
      if (visits.includes(visit)) {
        visit.answers.push(frame.answer);
        answers.push(frame.answer);
        return;
      }
      Object.assign(visit.first, frame);
      visits.push(visit);
      started.resolve();
    };
    const closed = Promise.withResolvers<void>();
    socket.onclose = () => {
      started.resolve();
      closed.resolve();
    };
    scripts.push(
      started.promise.then(async () => {
        if (socket.readyState === WebSocket.OPEN) {
          const script = options.script ?? EXIT_ZERO;
          await script(socket, visit.first, answers, inputs);
        }
        await closed.promise;
      }),
    );
    return response;
  });
  try {
    await body(`http://127.0.0.1:${server.addr.port}`, visits);
  } finally {
    await Promise.allSettled(scripts);
    await server.shutdown();
  }
}
