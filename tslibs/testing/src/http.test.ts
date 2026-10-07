/**
 * Контракт подставного сервера: обработчик видит запрос и отвечает;
 * брошенное в нём — 500; ушёл клиент — тело отменяется; оборвалось тело —
 * клиент видит обрыв; после `stop` порт закрыт; `closedPort` — порт, где
 * никто не слушает.
 */

import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { closedPort, serveFetch } from "../index.ts";

/** Исход соединения с портом петли: принято или код отказа. */
function dial(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (err: NodeJS.ErrnoException) =>
      resolve(err.code ?? err.message),
    );
  });
}

describe("serveFetch", () => {
  it("обработчик видит метод, путь и тело и отвечает", async () => {
    const server = await serveFetch(async (request) => {
      const url = new URL(request.url);
      return new Response(
        `${request.method} ${url.pathname} ${await request.text()}`,
        { status: 201, headers: { "x-seen": "yes" } },
      );
    });
    try {
      const response = await fetch(`${server.baseUrl}/echo`, {
        method: "POST",
        body: "hi",
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("x-seen")).toBe("yes");
      expect(await response.text()).toBe("POST /echo hi");
    } finally {
      await server.stop();
    }
  });

  it("брошенное в обработчике — ответ 500", async () => {
    const server = await serveFetch(() => {
      throw new Error("обработчик упал (ожидаемо в этом тесте)");
    });
    try {
      const response = await fetch(`${server.baseUrl}/`);
      expect(response.status).toBe(500);
      await response.body?.cancel();
    } finally {
      await server.stop();
    }
  });

  it("клиент ушёл — тело ответа отменяется", async () => {
    let cancelled!: () => void;
    const cancel = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const server = await serveFetch(
      () =>
        new Response(
          // Первый кусок — и тело висит: ответ начат, конца нет.
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new Uint8Array([1])),
            cancel: () => cancelled(),
          }),
        ),
    );
    try {
      const client = new AbortController();
      const response = await fetch(`${server.baseUrl}/`, {
        signal: client.signal,
      });
      await response.body?.getReader().read();
      client.abort();
      await cancel;
    } finally {
      await server.stop();
    }
  });

  it("тело оборвалось у обработчика — клиент видит обрыв", async () => {
    let fail!: (reason: Error) => void;
    const server = await serveFetch(
      () =>
        new Response(
          // Первый кусок доходит до клиента, обрыв — по команде теста:
          // рвётся начатый ответ, а не запрос до заголовков.
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1]));
              fail = (reason) => controller.error(reason);
            },
          }),
        ),
    );
    try {
      const response = await fetch(`${server.baseUrl}/`);
      if (response.body === null) throw new Error("ответ без тела");
      const reader = response.body.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1]));
      fail(new Error("тело оборвалось (ожидаемо в этом тесте)"));
      await expect(reader.read()).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("после stop порт не принимает соединений", async () => {
    const server = await serveFetch(() => new Response("ok"));
    await server.stop();
    expect(await dial(server.port)).toBe("ECONNREFUSED");
  });
});

describe("closedPort", () => {
  it("на порту никто не слушает", async () => {
    expect(await dial(await closedPort())).toBe("ECONNREFUSED");
  });
});
