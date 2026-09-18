/**
 * Для тестов клиента: окружение с подменами и записывающий сервер,
 * который видит дверь, токен и первый кадр и отвечает кадрами сценария.
 */

import type { ClientEnv } from "./client.ts";

/** Окружение клиента и то, что он напечатал. */
export interface TestEnv {
  readonly env: ClientEnv;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly interrupt: () => void;
}

export interface EnvSetup {
  readonly base: string;
  readonly main?: string;
  readonly agent?: string;
  readonly terminals?: boolean;
  /** Строки stdin по очереди; кончились — конец ввода. */
  readonly answers?: readonly string[];
}

export function testEnv(setup: EnvSetup): TestEnv {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const answers = [...setup.answers ?? []];
  const interrupted = Promise.withResolvers<void>();
  return {
    stdout,
    stderr,
    interrupt: () => interrupted.resolve(),
    env: {
      base: setup.base,
      mainTokenPath: "/home/test/.config/mpu/token",
      mainToken: () => Promise.resolve(setup.main),
      agentToken: () => Promise.resolve(setup.agent),
      terminals: setup.terminals ?? false,
      readLine: () => Promise.resolve(answers.shift()),
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
}

/** Сценарий сервера: что ответить на строку. */
export type Script = (
  socket: WebSocket,
  first: Record<string, unknown>,
  answers: AsyncIterable<string>,
) => Promise<void>;

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
    };
    const { socket, response } = Deno.upgradeWebSocket(request, {
      protocol: "mpu",
    });
    const answers = new Answers();
    const started = Promise.withResolvers<void>();
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
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
          await (options.script ?? EXIT_ZERO)(socket, visit.first, answers);
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
