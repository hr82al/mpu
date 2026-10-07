/**
 * Отмена вызова снаружи: долгий опрос Bot API держит соединение до 35 с,
 * и остановка ядра не должна ждать его конца
 * (`docs/specs/platform/telegram-questions.md`, «Приём апдейтов»).
 */

import { expect, it } from "vitest";
import { serveFetch } from "../testing/http.ts";
import { rejected } from "../testing/thrown.ts";
import { HttpCallError, httpSend } from "./mod.ts";

/** Сервер, который не отвечает, пока тест его не отпустит. */
async function withSilentServer(
  run: (url: URL, arrived: Promise<void>) => Promise<void>,
): Promise<void> {
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const server = await serveFetch(async () => {
    arrived.resolve();
    await release.promise;
    return new Response("поздно");
  });
  try {
    await run(new URL(`${server.baseUrl}/`), arrived.promise);
  } finally {
    release.resolve();
    await server.stop();
  }
}

it("сигнал снаружи обрывает вызов, не дожидаясь пределов", async () => {
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
    const err = await rejected(() => call, HttpCallError);
    expect(err.message.startsWith("no response"), err.message).toBe(false);
  });
});

it("уже отменённый сигнал — вызов не уходит", async () => {
  let calls = 0;
  const server = await serveFetch(() => {
    calls += 1;
    return new Response("");
  });
  try {
    await expect(
      httpSend(new URL(`${server.baseUrl}/`), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(HttpCallError);
  } finally {
    await server.stop();
  }
  expect(calls).toBe(0);
});
