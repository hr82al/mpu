/**
 * Следование редиректам — контракт `fetch`, которым транспорт ходил до
 * порции E3 (`docs/specs/platform/node-runtime.md`, [S.9]: поведение не
 * меняется): до 20 переходов, относительный `Location`, смена метода на
 * `GET` у 303 и у 301/302 при `POST`, 307/308 сохраняют метод и тело,
 * `Authorization` не уходит на чужой origin.
 */

import { describe, expect, it } from "vitest";
import { type FakeHttp, serveFetch } from "@mpu/testing";
import { rejected } from "@mpu/testing/thrown";
import { HttpCallError, httpGet, httpSend } from "../index.ts";

const TIMEOUTS = { headersTimeoutMs: 2000, totalTimeoutMs: 5000 };

/** Что увидел сервер: метод, путь, тело, тип и учётка запроса. */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly type: string | null;
  readonly auth: string | null;
}

/**
 * Сервер: `/from` отвечает `status` с `Location: to`, `/to` — телом
 * `landed`. Запросы запоминаются по порядку.
 */
async function redirecting(
  status: number,
  to: (server: string) => string,
): Promise<{ readonly server: FakeHttp; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  let base = "";
  const server = await serveFetch(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({
      method: request.method,
      path,
      body: await request.text(),
      type: request.headers.get("content-type"),
      auth: request.headers.get("authorization"),
    });
    if (path === "/from") {
      return new Response(null, {
        status,
        headers: { location: to(base) },
      });
    }
    return new Response("landed");
  });
  base = server.baseUrl;
  return { server, seen };
}

/** POST с JSON-телом и учёткой на `/from` сервера. */
function post(server: FakeHttp) {
  return httpSend(new URL(`${server.baseUrl}/from`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer t0ken",
    },
    body: "{}",
    timeouts: TIMEOUTS,
    env: {},
  });
}

describe("редирект на POST: метод и тело — как у fetch", () => {
  const cases = [
    [302, "GET", "", null],
    [303, "GET", "", null],
    [301, "GET", "", null],
    [307, "POST", "{}", "application/json"],
    [308, "POST", "{}", "application/json"],
  ] as const;
  for (const [status, method, body, type] of cases) {
    it(`${status} → ${method}`, async () => {
      const { server, seen } = await redirecting(status, () => "/to");
      try {
        const response = await post(server);
        expect(response.text).toBe("landed");
        expect(seen[1], "второй запрос").toStrictEqual({
          method,
          path: "/to",
          body,
          type,
          // Тот же origin — учётка идёт дальше.
          auth: "Bearer t0ken",
        });
      } finally {
        await server.stop();
      }
    });
  }
});

it("редирект на чужой origin — Authorization не уходит", async () => {
  const target = await redirecting(200, () => "/to");
  // `localhost` и `127.0.0.1` — один сервер, но разные origin.
  const { server, seen } = await redirecting(
    307,
    () => `http://localhost:${target.server.port}/to`,
  );
  try {
    const response = await post(server);
    expect(response.text).toBe("landed");
    expect(seen.length, "запросов первому серверу").toBe(1);
    expect(target.seen.map((s) => s.auth)).toStrictEqual([null]);
  } finally {
    await server.stop();
    await target.server.stop();
  }
});

it("GET идёт по цепочке до ответа без редиректа", async () => {
  const { server, seen } = await redirecting(302, (base) => `${base}/to`);
  try {
    const response = await httpGet(new URL(`${server.baseUrl}/from`), {
      timeouts: TIMEOUTS,
      env: {},
    });
    expect(response.status).toBe(200);
    expect(response.text).toBe("landed");
    expect(seen.map((s) => `${s.method} ${s.path}`)).toStrictEqual([
      "GET /from",
      "GET /to",
    ]);
  } finally {
    await server.stop();
  }
});

it("больше 20 переходов — отказ вызова своим текстом", async () => {
  // `/from` ведёт сам на себя: цепочка бесконечна.
  const { server, seen } = await redirecting(302, () => "/from");
  try {
    const err = await rejected(
      () =>
        httpGet(new URL(`${server.baseUrl}/from`), {
          timeouts: TIMEOUTS,
          env: {},
        }),
      HttpCallError,
    );
    expect(err.message).toBe("больше 20 переходов по редиректам");
    expect(seen.length, "запросов: первый и 20 переходов").toBe(21);
  } finally {
    await server.stop();
  }
});

it("редирект без Location — ответ как есть", async () => {
  const server = await serveFetch(() => new Response("тело", { status: 302 }));
  try {
    const response = await httpGet(new URL(`${server.baseUrl}/`), {
      timeouts: TIMEOUTS,
      env: {},
    });
    expect([response.status, response.text]).toStrictEqual([302, "тело"]);
  } finally {
    await server.stop();
  }
});

it("303 на HEAD — метод остаётся HEAD", async () => {
  const { server, seen } = await redirecting(303, () => "/to");
  try {
    await httpSend(new URL(`${server.baseUrl}/from`), {
      method: "HEAD",
      timeouts: TIMEOUTS,
      env: {},
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toStrictEqual([
      "HEAD /from",
      "HEAD /to",
    ]);
  } finally {
    await server.stop();
  }
});

it("Authorization с заглавной — тоже не уходит на чужой origin", async () => {
  const target = await redirecting(200, () => "/to");
  const { server } = await redirecting(
    302,
    () => `http://localhost:${target.server.port}/to`,
  );
  try {
    await httpGet(new URL(`${server.baseUrl}/from`), {
      headers: { Authorization: "Bearer t0ken" },
      timeouts: TIMEOUTS,
      env: {},
    });
    expect(target.seen.map((s) => s.auth)).toStrictEqual([null]);
  } finally {
    await server.stop();
    await target.server.stop();
  }
});

describe("непригодный Location — отказ вызова, как у fetch", () => {
  const cases = [
    ["чужая схема", "ftp://example.test/x", "редирект на схему ftp"],
    [
      "учётные данные в адресе",
      "http://u:p@example.test/x",
      "редирект на адрес с учётными данными",
    ],
    ["не разбирается", "http://[bad", "редирект на неразбираемый адрес"],
  ] as const;
  for (const [name, location, text] of cases) {
    it(name, async () => {
      const { server, seen } = await redirecting(302, () => location);
      try {
        const err = await rejected(
          () =>
            httpGet(new URL(`${server.baseUrl}/from`), {
              timeouts: TIMEOUTS,
              env: {},
            }),
          HttpCallError,
        );
        expect(err.message).toBe(text);
        expect(seen.length, "запросов серверу").toBe(1);
      } finally {
        await server.stop();
      }
    });
  }
});

it("молчащий переход — предел заголовков действует и на нём", async () => {
  // Предел заголовков снимается не ответом-редиректом, а только
  // окончательным ответом: без общего предела (`null`, как у запроса
  // логов) молчащий второй переход иначе висел бы вечно.
  const release = Promise.withResolvers<void>();
  const server = await serveFetch(async (request) => {
    if (new URL(request.url).pathname === "/from") {
      return new Response(null, { status: 302, headers: { location: "/to" } });
    }
    await release.promise;
    return new Response("поздно");
  });
  try {
    const err = await rejected(
      () =>
        httpGet(new URL(`${server.baseUrl}/from`), {
          timeouts: { headersTimeoutMs: 200, totalTimeoutMs: null },
          env: {},
        }),
      HttpCallError,
    );
    expect(err.message).toBe("no response headers within 200ms");
  } finally {
    release.resolve();
    await server.stop();
  }
});
