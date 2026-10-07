/**
 * Выбор прокси транспорта (`docs/specs/platform/node-runtime.md`, [S.9];
 * `platform/tslibs-http.md`, [S.6]–[S.7]; наблюдаемый след «Прокси
 * окружения» — `platform/loki-http.md`): явный → окружение → напрямую;
 * адрес стенда и адрес из `NO_PROXY` идут мимо прокси окружения.
 *
 * Окружение передаётся вызову параметром (`env`), а не процессу:
 * унаследованный `NO_PROXY` с `127.0.0.1` сделал бы тест зелёным по
 * совпадению, а правка окружения процесса задела бы соседние тесты.
 */

import type { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { type FakeHttp, serveFetch } from "../testing/http.ts";
import { rejected } from "../testing/thrown.ts";
import { HttpCallError, httpGet, httpSend } from "./mod.ts";

const TIMEOUTS = { headersTimeoutMs: 2000, totalTimeoutMs: 5000 };

/** Сервер на петле, отвечающий телом `body` и помнящий число запросов. */
async function listen(body: string): Promise<{
  readonly server: FakeHttp;
  readonly requests: () => number;
}> {
  let count = 0;
  const server = await serveFetch(async (request) => {
    count++;
    await request.body?.cancel();
    return new Response(body);
  });
  return { server, requests: () => count };
}

/** Окружение вызова: прокси — ловушка, `NO_PROXY` пуст. */
function proxyEnv(trap: string): Record<string, string> {
  const env: Record<string, string> = { NO_PROXY: "", no_proxy: "" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = trap;
    env[name.toLowerCase()] = trap;
  }
  return env;
}

it("адрес стенда идёт мимо прокси окружения, явный прокси и домен — через него", async () => {
  const target = await listen("target");
  const trap = await listen("trap");
  try {
    const env = proxyEnv(trap.server.baseUrl);
    const port = target.server.port;
    const stand = new URL(`http://127.0.0.1:${port}/ready`);
    // Тот же сервер по имени `localhost`: имя адресом стенда не считается,
    // и мимо прокси такой вызов получил бы ответ сервера, а не ловушки.
    const domain = new URL(`http://localhost:${port}/ready`);
    const bodies = {
      get: (await httpGet(stand, { timeouts: TIMEOUTS, env })).text,
      send: (await httpSend(stand, {
        timeouts: TIMEOUTS,
        method: "POST",
        body: "x",
        env,
      })).text,
      explicit: (await httpSend(stand, {
        timeouts: TIMEOUTS,
        proxy: trap.server.baseUrl,
        env,
      })).text,
      domain: (await httpGet(domain, { timeouts: TIMEOUTS, env })).text,
    };
    expect(bodies).toStrictEqual({
      get: "target",
      send: "target",
      explicit: "trap",
      domain: "trap",
    });
    // Два запроса ловушке — явный прокси и доменное имя; вызовы к адресу
    // стенда её не касаются.
    expect(trap.requests(), "запросов ловушке").toBe(2);
    expect(target.requests(), "запросов серверу").toBe(2);
  } finally {
    await target.server.stop();
    await trap.server.stop();
  }
});

/** Прокси CONNECT на петле: помнит стартовые строки и заголовок учётки. */
interface Tunnel {
  readonly url: string;
  readonly connects: string[];
  readonly authorizations: (string | undefined)[];
  /** Сколько туннелей открыто до сервера за прокси. */
  readonly opened: () => number;
  readonly stop: () => Promise<void>;
}

/**
 * Туннель ведёт на `upstreamPort` петли, какой бы адрес ни назвали в
 * CONNECT: имя `example.test` не разрешается, а дойти до сервера надо.
 */
async function tunnel(
  upstreamPort: number,
  refusal?: number,
): Promise<Tunnel> {
  const connects: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  let opened = 0;
  const server: Server = createServer();
  server.on("connect", (req, client: Socket, head: Buffer) => {
    connects.push(req.url ?? "");
    authorizations.push(req.headers["proxy-authorization"]);
    sockets.add(client);
    if (refusal !== undefined) {
      client.end(`HTTP/1.1 ${refusal} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1", () => {
      opened++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      // Обрыв одной стороны гасит обе: клиент бросает рукопожатие TLS.
      socket.on("error", () => client.destroy());
      socket.on("close", () => upstream.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://u:p%40ss@127.0.0.1:${port}`,
    connects,
    authorizations,
    opened: () => opened,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("https через прокси — туннель CONNECT", () => {
  // Сервер за туннелем — простой TCP-слушатель: рукопожатие TLS с ним не
  // состоится, но CONNECT, по которому оно пошло бы, уже записан прокси.
  const cases = [
    ["явный прокси", (url: string) => ({ proxy: url, env: {} })],
    ["HTTPS_PROXY окружения", (url: string) => ({ env: { HTTPS_PROXY: url } })],
    ["ALL_PROXY окружения", (url: string) => ({ env: { all_proxy: url } })],
  ] as const;
  for (const [name, options] of cases) {
    it(name, async () => {
      const target = await listen("target");
      const proxy = await tunnel(target.server.port);
      try {
        await rejected(
          () =>
            httpSend(new URL("https://example.test/x"), {
              timeouts: TIMEOUTS,
              ...options(proxy.url),
            }),
          HttpCallError,
        );
        expect(proxy.connects, "стартовые строки CONNECT").toStrictEqual([
          "example.test:443",
        ]);
        expect(proxy.authorizations, "учётные данные прокси").toStrictEqual([
          `Basic ${btoa("u:p@ss")}`,
        ]);
        // Ответ сервера за туннелем на петле без доверенного корня не
        // показать: рукопожатие TLS с ним не состоится. Видно другое —
        // туннель до сервера открыт, и байты рукопожатия ушли в него.
        expect(proxy.opened(), "туннелей до сервера").toBe(1);
      } finally {
        await proxy.stop();
        await target.server.stop();
      }
    });
  }
});

describe("NO_PROXY — мимо прокси окружения", () => {
  const cases = [
    ["хост целиком", (_port: number) => "localhost", "target"],
    ["звёздочка", (_port: number) => "*", "target"],
    ["хост с тем же портом", (port: number) => `localhost:${port}`, "target"],
    ["хост с другим портом", (port: number) => `localhost:${port + 1}`, "trap"],
    ["домен с точкой — не этот хост", (_port: number) => ".example", "trap"],
  ] as const;
  for (const [name, entry, expected] of cases) {
    it(name, async () => {
      const target = await listen("target");
      const trap = await listen("trap");
      try {
        const port = target.server.port;
        const env = { HTTP_PROXY: trap.server.baseUrl, NO_PROXY: entry(port) };
        const { text } = await httpGet(new URL(`http://localhost:${port}/`), {
          timeouts: TIMEOUTS,
          env,
        });
        expect(text).toBe(expected);
      } finally {
        await target.server.stop();
        await trap.server.stop();
      }
    });
  }
});

it("прокси окружения непонятной схемы — отказ до сети без учётных данных", async () => {
  const err = await rejected(
    () =>
      httpGet(new URL("https://example.test/x"), {
        timeouts: TIMEOUTS,
        env: { ALL_PROXY: "socks4://u:secret@127.0.0.1:1" },
      }),
    HttpCallError,
  );
  expect(err.message).toBe(
    "прокси не принят клиентом — 'socks4://127.0.0.1:1': " +
      "схема socks4 не поддерживается",
  );
});

it("http через прокси с учётными данными — запрос с полным адресом и Proxy-Authorization", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const trap = await serveFetch(async (request) => {
    seen.push({
      url: request.url,
      auth: request.headers.get("proxy-authorization"),
    });
    await request.body?.cancel();
    return new Response("trap");
  });
  try {
    const port = trap.port;
    const { text } = await httpSend(new URL("http://example.test/x?q=1"), {
      timeouts: TIMEOUTS,
      proxy: `http://u:p%40ss@127.0.0.1:${port}`,
      env: {},
    });
    expect(text).toBe("trap");
    // Хост запроса — адрес вызова, а не прокси: прокси сам идёт к нему.
    expect(seen).toStrictEqual([{
      url: "http://example.test/x?q=1",
      auth: `Basic ${btoa("u:p@ss")}`,
    }]);
  } finally {
    await trap.stop();
  }
});

it("https без проверки TLS — напрямую, мимо прокси окружения", async () => {
  // Прежнее правило транспорта: отключённая проверка сертификата
  // (`PORTAINER_VERIFY_TLS`) — вызов идёт сам, прокси не применяется. Порт
  // закрыт — вызов отказывает, а прокси не видит ни одного CONNECT.
  const target = await listen("target");
  const proxy = await tunnel(target.server.port);
  const closed = target.server.port;
  await target.server.stop();
  try {
    await rejected(
      () =>
        httpGet(new URL(`https://localhost:${closed}/`), {
          timeouts: TIMEOUTS,
          insecure: true,
          env: { HTTPS_PROXY: proxy.url },
        }),
      HttpCallError,
    );
    expect(proxy.connects, "CONNECT к прокси").toStrictEqual([]);
  } finally {
    await proxy.stop();
  }
});

it("прокси окружения не разбирается — отказ до сети своей ошибкой вызова", async () => {
  const err = await rejected(
    () =>
      httpGet(new URL("https://example.test/x"), {
        timeouts: TIMEOUTS,
        env: { HTTPS_PROXY: "http://u:secret@[не адрес" },
      }),
    HttpCallError,
  );
  expect(
    err.message.startsWith(
      "прокси не принят клиентом — '[не адрес': адрес не разбирается",
    ),
  )
    .toBe(true);
  expect(err.message.includes("secret"), err.message).toBe(false);
});

it("прокси отказал в туннеле — отказ вызова, а не ответ API", async () => {
  // 403 прокси на CONNECT иначе дошёл бы до клиента ответом самого API
  // (`bot_call.ts` прочёл бы его как «403 Bot API»).
  const proxy = await tunnel(1, 403);
  try {
    const err = await rejected(
      () =>
        httpSend(new URL("https://example.test/x"), {
          timeouts: TIMEOUTS,
          proxy: proxy.url,
          env: {},
        }),
      HttpCallError,
    );
    expect(err.message).toBe("прокси отказал в туннеле: 403");
    expect(proxy.opened(), "туннелей до сервера").toBe(0);
  } finally {
    await proxy.stop();
  }
});

describe("старшинство источников прокси", () => {
  const cases = [
    [
      "явный старше окружения",
      (a: string, b: string) => ({ proxy: a, env: { HTTP_PROXY: b } }),
    ],
    [
      "верхний регистр старше нижнего",
      (a: string, b: string) => ({ env: { HTTP_PROXY: a, http_proxy: b } }),
    ],
    [
      "переменная схемы старше ALL_PROXY",
      (a: string, b: string) => ({ env: { HTTP_PROXY: a, ALL_PROXY: b } }),
    ],
  ] as const;
  for (const [name, options] of cases) {
    it(name, async () => {
      const first = await listen("первый");
      const second = await listen("второй");
      try {
        const { text } = await httpSend(new URL("http://example.test/x"), {
          timeouts: TIMEOUTS,
          ...options(first.server.baseUrl, second.server.baseUrl),
        });
        expect(text).toBe("первый");
        expect(second.requests(), "запросов второму").toBe(0);
      } finally {
        await first.server.stop();
        await second.server.stop();
      }
    });
  }
});

it("NO_PROXY — домен целиком: поддомен идёт мимо прокси", async () => {
  // Мимо прокси имя `example.test` не разрешается — вызов отказывает, а
  // ловушка не получает ничего.
  const trap = await listen("trap");
  try {
    await rejected(
      () =>
        httpGet(new URL("http://api.example.test/x"), {
          timeouts: TIMEOUTS,
          env: { HTTP_PROXY: trap.server.baseUrl, NO_PROXY: "example.test" },
        }),
      HttpCallError,
    );
    expect(trap.requests(), "запросов ловушке").toBe(0);
  } finally {
    await trap.server.stop();
  }
});

it("адрес IPv6 — соединение с хостом без скобок", async () => {
  // `URL.hostname` держит скобки (`[::1]`), а сокет со скобками ищет имя в
  // DNS. Сервер слушает только IPv4-петлю — значит, дойти до `::1` вызов
  // не может, и важно, чем он отказал: не `ENOTFOUND` по имени `[::1]`.
  const err = await rejected(
    () => httpGet(new URL("http://[::1]:1/"), { timeouts: TIMEOUTS, env: {} }),
    HttpCallError,
  );
  expect(err.message.includes("ENOTFOUND"), err.message).toBe(false);
});
