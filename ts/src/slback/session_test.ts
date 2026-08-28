/**
 * Сеанс sl-back (`platform/slback-http.md`): токен из кэша либо логин,
 * форма запроса под токеном и разбор ответа.
 *
 * Стенд настоящий, на петле: проверяется то, что ушло по сети, а не
 * то, что мы собирались отправить.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, type EnvFile } from "../command/mod.ts";
import {
  NoAccessTokenError,
  openSlback,
  SlbackError,
  type SlbackIo,
  truncate,
} from "./mod.ts";
import { loginReply, startFakeSlback } from "./testing.ts";

const CREDS = { TOKEN_EMAIL: "кто@test", TOKEN_PASSWORD: "пароль" };

function ioTo(
  baseUrl: string,
  opts: {
    cache?: string;
    onWrite?: (text: string) => void;
    env?: Record<string, string>;
  } = {},
): SlbackIo {
  const values: Record<string, string> = {
    BASE_API_URL: baseUrl,
    ...CREDS,
    ...opts.env,
  };
  const envFile: EnvFile = {
    get: (name) => values[name],
    require: () => {
      throw new Error("require не ожидается");
    },
    set: () => Promise.reject(new Error("set не ожидается")),
    values: () => ({ ...values }),
  };
  return {
    envFile,
    readTokenCache: () => Promise.resolve(opts.cache),
    writeTokenCache: (text) => {
      opts.onWrite?.(text);
      return Promise.resolve();
    },
  };
}

Deno.test("живой кэш отдаёт токен без единого запроса", async () => {
  const stand = startFakeSlback(() =>
    new Response("не ожидается", { status: 500 })
  );
  try {
    const cache = JSON.stringify({ token: "из-кэша", expires_at: 2000 });
    const session = openSlback(ioTo(stand.baseUrl, { cache }), () => 1999);
    assertEquals(await session.token(), "из-кэша");
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("холодный кэш: логин без авторизации, запрос — под Bearer", async () => {
  const written: string[] = [];
  const stand = startFakeSlback((seen) =>
    seen.length === 1 ? loginReply("svezhiy") : Response.json({ id: 777 })
  );
  try {
    const io = ioTo(stand.baseUrl, { onWrite: (text) => written.push(text) });
    const session = openSlback(io, () => 100);
    // Числа возвращаются в обёртке, печатающей исходный текст, поэтому
    // сверяется печать, а не структура (см. `parseJsonVerbatim`).
    assertEquals(
      JSON.stringify(await session.call("GET", "/admin/client/777")),
      '{"id":777}',
    );

    assertEquals(stand.seen.length, 2);
    const [login, call] = stand.seen;
    assertEquals(login.method, "POST");
    assertEquals(login.pathname, "/auth/login");
    assertEquals(login.authorization, null);
    assertEquals(login.contentType, "application/json");
    assertEquals(JSON.parse(login.body), {
      email: "кто@test",
      password: "пароль",
    });
    assertEquals(call.method, "GET");
    assertEquals(call.pathname, "/admin/client/777");
    // Токен уходит только заголовком авторизации — в ASCII, как того
    // требует HTTP; JWT такой и есть.
    assertEquals(call.authorization, "Bearer svezhiy");
    // Запрос без тела не несёт и заголовка типа содержимого.
    assertEquals(call.contentType, null);
    assertEquals(call.body, "");
    assertEquals(written, [
      JSON.stringify({ token: "svezhiy", expires_at: 700 }),
    ]);
  } finally {
    await stand.stop();
  }
});

Deno.test("сбой записи кэша не роняет вызов: токен уже получен", async () => {
  const stand = startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : Response.json({ ok: true })
  );
  try {
    const io = {
      ...ioTo(stand.baseUrl),
      writeTokenCache: () => Promise.reject(new Error("нет прав на каталог")),
    };
    assertEquals(await openSlback(io).call("GET", "/admin/roles"), {
      ok: true,
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("логин без accessToken — свой класс отказа и тело в тексте", async () => {
  const stand = startFakeSlback(() => Response.json({ user: { id: 1 } }));
  try {
    const err = await assertRejects(
      () => openSlback(ioTo(stand.baseUrl)).token(),
      NoAccessTokenError,
    );
    assertEquals(
      err.message,
      'sl-back login: нет accessToken в ответе: {"user":{"id":1}}',
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("HTTP ≥ 400 — отказ с кодом и сохранённым телом", async () => {
  const stand = startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : new Response("client not found", { status: 404 })
  );
  try {
    const err = await assertRejects(
      () => openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/client/1"),
      SlbackError,
    );
    assertEquals(err.message, "GET /admin/client/1 failed: HTTP 404");
    assertEquals(err.status, 404);
    assertEquals(err.body, "client not found");
  } finally {
    await stand.stop();
  }
});

Deno.test("2xx с HTML-телом — non-JSON, несмотря на успешный статус", async () => {
  const stand = startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : new Response("<html>вход</html>")
  );
  try {
    const err = await assertRejects(
      () => openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/roles"),
      SlbackError,
    );
    assertEquals(
      err.message,
      "GET /admin/roles: non-JSON response: <html>вход</html>",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("2xx с пустым телом — нет данных, а не ошибка", async () => {
  const stand = startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : new Response(null, { status: 204 })
  );
  try {
    assertEquals(
      await openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/roles"),
      undefined,
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("тело ответа обрезается с маркером и числом байт хвоста", () => {
  assertEquals(truncate("ровно", 5), "ровно");
  // Хвост считается в байтах: кириллица — по два на символ.
  assertEquals(truncate("аб", 1), "а…(+2 bytes)");
});

Deno.test("числа ответа печатаются как пришли, без потери точности", async () => {
  const stand = startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : new Response('{"id":123456789012345678901,"ratio":1.0}', {
        headers: { "content-type": "application/json" },
      })
  );
  try {
    const response = await openSlback(ioTo(stand.baseUrl)).call(
      "GET",
      "/admin/client/1",
    );
    assertEquals(
      JSON.stringify(response),
      '{"id":123456789012345678901,"ratio":1.0}',
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("нет адреса — отказ до сети, у вызова и у логина", async () => {
  const io = ioTo("", { env: { BASE_API_URL: "" } });
  for (
    const attempt of [
      () => openSlback(io).call("GET", "/admin/roles"),
      () => openSlback(io).token(),
    ]
  ) {
    const err = await assertRejects(attempt, DomainError);
    assertStringIncludes(err.message, "sl-back base URL не задан");
  }
});

Deno.test("живой кэш адреса не спрашивает: за токеном идти некуда", async () => {
  // Обратная сторона предыдущего: команде, которой хватило кэша, база
  // не нужна, и отказывать ей незачем.
  const io = ioTo("", {
    env: { BASE_API_URL: "" },
    cache: JSON.stringify({ token: "из-кэша", expires_at: 2000 }),
  });
  assertEquals(await openSlback(io, () => 1999).token(), "из-кэша");
});

Deno.test("тело отказа режется на 500 символов, не-JSON — на 200", async () => {
  const long = "я".repeat(700);
  const stand = startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : seen.length === 2
      ? new Response(long, { status: 400 })
      : new Response(long)
  );
  try {
    const session = openSlback(ioTo(stand.baseUrl));
    const failed = await assertRejects(
      () => session.call("GET", "/admin/roles"),
      SlbackError,
    );
    assertEquals(failed.body, truncate(long, 500));
    assertEquals(failed.body.startsWith("я".repeat(500) + "…(+"), true);

    const nonJson = await assertRejects(
      () => session.call("GET", "/admin/roles"),
      SlbackError,
    );
    assertStringIncludes(
      nonJson.message,
      `non-JSON response: ${truncate(long, 200)}`,
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("транспортный сбой называет метод, путь и причину одной строкой", async () => {
  const stand = startFakeSlback(() => loginReply());
  const baseUrl = stand.baseUrl;
  await stand.stop();
  const err = await assertRejects(
    () => openSlback(ioTo(baseUrl)).token(),
    SlbackError,
  );
  assertStringIncludes(
    err.message,
    "POST /auth/login failed: transport error: ",
  );
  assertEquals(err.message.split("\n").length, 1);
});
