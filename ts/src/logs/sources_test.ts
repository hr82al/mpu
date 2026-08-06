/**
 * Реализации границ команды поверх атомов (`sources.ts`): имена
 * контейнеров без ведущего `/`, снимок логов уже разобранным на потоки,
 * чтение записей Loki, потоки процесса и прерываемая пауза слежения.
 *
 * Фейковый HTTP-сервер — та же калька, что в соседних модулях.
 */

import { assertEquals } from "@std/assert";
import type { PortainerAccess } from "../portainer/mod.ts";
import {
  listContainerNamesOverHttp,
  processStream,
  readContainerLogsOverHttp,
  readLokiOverHttp,
  waitFor,
} from "./sources.ts";

function fakeServer(
  handler: (req: Request) => Response | Promise<Response>,
): { readonly baseUrl: string; readonly stop: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

function accessTo(baseUrl: string): PortainerAccess {
  // Ключ в заголовке — только ASCII: значение заголовка HTTP не
  // допускает иных байтов.
  return { baseUrl, apiKey: "proba-portainer-key", verifyTls: true };
}

Deno.test("имена контейнеров: все Names, ведущий слэш срезан", async () => {
  const body = JSON.stringify([
    {
      Id: "a",
      Names: ["/mp-api", "/mp-api-alias"],
      State: "running",
      Image: "",
    },
    { Id: "b", Names: ["mp-wb-loader"], State: "exited", Image: "" },
  ]);
  const { baseUrl, stop } = fakeServer(() =>
    new Response(body, { status: 200 })
  );
  try {
    assertEquals(await listContainerNamesOverHttp(accessTo(baseUrl), 4), [
      "mp-api",
      "mp-api-alias",
      "mp-wb-loader",
    ]);
  } finally {
    await stop();
  }
});

Deno.test("снимок логов приходит разобранным на потоки", async () => {
  const frame = (stream: number, text: string): Uint8Array => {
    const payload = new TextEncoder().encode(text);
    const out = new Uint8Array(8 + payload.length);
    out[0] = stream;
    new DataView(out.buffer).setUint32(4, payload.length, false);
    out.set(payload, 8);
    return out;
  };
  const body = new Uint8Array([...frame(1, "данные\n"), ...frame(2, "шум\n")]);
  const seen: URL[] = [];
  const { baseUrl, stop } = fakeServer((req) => {
    seen.push(new URL(req.url));
    return new Response(body, { status: 200 });
  });
  try {
    const streams = await readContainerLogsOverHttp(
      accessTo(baseUrl),
      4,
      "mp-api",
      { stdout: true, stderr: true, tail: 10, timestamps: false, sinceUnix: 5 },
    );
    const decoder = new TextDecoder();
    assertEquals(decoder.decode(streams.stdout), "данные\n");
    assertEquals(decoder.decode(streams.stderr), "шум\n");
    assertEquals(
      seen[0].pathname,
      "/api/endpoints/4/docker/containers/mp-api/logs",
    );
    assertEquals(
      seen[0].search,
      "?stdout=true&stderr=true&tail=10&follow=false&timestamps=false&since=5",
    );
  } finally {
    await stop();
  }
});

Deno.test("чтение Loki уходит в query_range", async () => {
  const body = JSON.stringify({
    data: { result: [{ values: [["1", "строка"]] }] },
  });
  const seen: URL[] = [];
  const { baseUrl, stop } = fakeServer((req) => {
    seen.push(new URL(req.url));
    return new Response(body, { status: 200 });
  });
  try {
    const entries = await readLokiOverHttp({ baseUrl }, {
      logql: '{host="sl-1"}',
      startNs: 1n,
      endNs: 2n,
      limit: 3,
      direction: "forward",
    });
    assertEquals(entries, [{ tsNs: "1", line: "строка" }]);
    assertEquals(seen[0].pathname, "/loki/api/v1/query_range");
  } finally {
    await stop();
  }
});

Deno.test("поток процесса: данные в stdout, диагностика в stderr", () => {
  const chunks: { readonly to: string; readonly text: string }[] = [];
  const decoder = new TextDecoder();
  const originals = [Deno.stdout.writeSync, Deno.stderr.writeSync];
  Deno.stdout.writeSync = (bytes: Uint8Array) => {
    chunks.push({ to: "stdout", text: decoder.decode(bytes) });
    return bytes.length;
  };
  Deno.stderr.writeSync = (bytes: Uint8Array) => {
    chunks.push({ to: "stderr", text: decoder.decode(bytes) });
    return bytes.length;
  };
  try {
    const stream = processStream();
    stream.out("строка\n");
    stream.err("сбой\n");
  } finally {
    Deno.stdout.writeSync = originals[0];
    Deno.stderr.writeSync = originals[1];
  }
  assertEquals(chunks, [
    { to: "stdout", text: "строка\n" },
    { to: "stderr", text: "сбой\n" },
  ]);
});

Deno.test("пауза слежения прерывается сигналом", async (t) => {
  await t.step("уже взведённый сигнал не ждёт вовсе", async () => {
    const controller = new AbortController();
    controller.abort();
    // Час ожидания завершается немедленно — иначе тест не уложился бы.
    await waitFor(3_600_000, controller.signal);
  });

  await t.step("сигнал во время паузы снимает и таймер", async () => {
    const controller = new AbortController();
    const waiting = waitFor(3_600_000, controller.signal);
    controller.abort();
    await waiting;
    // Санитайзер таймеров упал бы, останься setTimeout невзведённым.
  });
});
