/**
 * Отмена вызова снаружи: долгий опрос Bot API держит соединение до 35 с,
 * и остановка ядра не должна ждать его конца
 * (`docs/specs/platform/telegram-questions.md`, «Приём апдейтов»).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { HttpCallError, httpSend } from "./mod.ts";

/** Сервер, который не отвечает, пока тест его не отпустит. */
async function withSilentServer(
  run: (url: URL, arrived: Promise<void>) => Promise<void>,
): Promise<void> {
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async () => {
      arrived.resolve();
      await release.promise;
      return new Response("поздно");
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    await run(new URL(`http://127.0.0.1:${port}/`), arrived.promise);
  } finally {
    release.resolve();
    await server.shutdown();
  }
}

Deno.test("сигнал снаружи обрывает вызов, не дожидаясь пределов", async () => {
  await withSilentServer(async (url, arrived) => {
    const stop = new AbortController();
    const call = httpSend(url, {
      method: "POST",
      body: "{}",
      // Пределы короткие, чтобы без отмены вызов кончился ими же, —
      // и тогда причина назвала бы предел, а не отмену.
      timeouts: { headersTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
      signal: stop.signal,
    });
    await arrived;
    stop.abort();
    const err = await assertRejects(() => call, HttpCallError);
    assertEquals(err.message.startsWith("no response"), false, err.message);
  });
});

Deno.test("уже отменённый сигнал — вызов не уходит", async () => {
  let calls = 0;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => {
      calls += 1;
      return new Response("");
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    await assertRejects(
      () =>
        httpSend(new URL(`http://127.0.0.1:${port}/`), {
          signal: AbortSignal.abort(),
        }),
      HttpCallError,
    );
  } finally {
    await server.shutdown();
  }
  assertEquals(calls, 0);
});
