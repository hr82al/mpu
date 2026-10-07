/**
 * Реализации границ команды поверх атомов (`sources.ts`): имена
 * контейнеров без ведущего `/`, снимок логов уже разобранным на потоки,
 * чтение записей Loki, потоки процесса и прерываемая пауза слежения.
 *
 * Фейковый HTTP-сервер — та же калька, что в соседних модулях.
 */

import { describe, expect, it } from "vitest";
import { serveLoopback } from "../exec/testserve.ts";
import type { PortainerAccess } from "../portainer/mod.ts";
import {
  listAllContainerNamesOverHttp,
  readContainerLogsOverHttp,
  readLokiOverHttp,
  waitFor,
} from "./sources.ts";

async function fakeServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ readonly baseUrl: string; readonly stop: () => Promise<void> }> {
  const server = await serveLoopback(handler);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.close(),
  };
}

function accessTo(baseUrl: string): PortainerAccess {
  // Ключ в заголовке — только ASCII: значение заголовка HTTP не
  // допускает иных байтов.
  return { baseUrl, apiKey: "proba-portainer-key", verifyTls: true };
}

it("имена контейнеров: все Names, ведущий слэш срезан", async () => {
  const body = JSON.stringify([
    {
      Id: "a",
      Names: ["/mp-api", "/mp-api-alias"],
      State: "running",
      Image: "",
    },
    { Id: "b", Names: ["mp-wb-loader"], State: "exited", Image: "" },
  ]);
  const { baseUrl, stop } = await fakeServer(() =>
    new Response(body, { status: 200 })
  );
  try {
    expect(await listAllContainerNamesOverHttp(accessTo(baseUrl), 4))
      .toStrictEqual([
        "mp-api",
        "mp-api-alias",
        "mp-wb-loader",
      ]);
  } finally {
    await stop();
  }
});

it("снимок логов приходит разобранным на потоки", async () => {
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
  const { baseUrl, stop } = await fakeServer((req) => {
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
    expect(decoder.decode(streams.stdout)).toBe("данные\n");
    expect(decoder.decode(streams.stderr)).toBe("шум\n");
    expect(seen[0].pathname).toBe(
      "/api/endpoints/4/docker/containers/mp-api/logs",
    );
    expect(seen[0].search).toBe(
      "?stdout=true&stderr=true&tail=10&follow=false&timestamps=false&since=5",
    );
  } finally {
    await stop();
  }
});

it("чтение Loki уходит в query_range", async () => {
  const body = JSON.stringify({
    data: { result: [{ values: [["1", "строка"]] }] },
  });
  const seen: URL[] = [];
  const { baseUrl, stop } = await fakeServer((req) => {
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
    expect(entries).toStrictEqual([{ tsNs: "1", line: "строка", labels: {} }]);
    expect(seen[0].pathname).toBe("/loki/api/v1/query_range");
  } finally {
    await stop();
  }
});

describe("пауза слежения прерывается сигналом", () => {
  it("уже взведённый сигнал не ждёт вовсе", async () => {
    const controller = new AbortController();
    controller.abort();
    // Час ожидания завершается немедленно — иначе тест не уложился бы.
    await waitFor(3_600_000, controller.signal);
  });

  it("сигнал во время паузы снимает и таймер", async () => {
    const controller = new AbortController();
    const waiting = waitFor(3_600_000, controller.signal);
    controller.abort();
    await waiting;
    // Висящий таймер этот случай не ловит: санитайзера нет ни у Vitest, ни
    // у `deno test` по умолчанию (`ts/CLAUDE.md`, «Асинхронность»).
  });
});
