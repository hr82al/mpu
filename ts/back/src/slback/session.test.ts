/**
 * Сеанс sl-back (`platform/slback-http.md`): токен из кэша либо логин,
 * форма запроса под токеном и разбор ответа.
 *
 * Стенд настоящий, на петле: проверяется то, что ушло по сети, а не
 * то, что мы собирались отправить.
 */

import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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

it("живой кэш отдаёт токен без единого запроса", async () => {
  const stand = await startFakeSlback(
    () => new Response("не ожидается", { status: 500 }),
  );
  try {
    const cache = JSON.stringify({ token: "из-кэша", expires_at: 2000 });
    const session = openSlback(ioTo(stand.baseUrl, { cache }), () => 1999);
    expect(await session.token()).toBe("из-кэша");
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("холодный кэш: логин без авторизации, запрос — под Bearer", async () => {
  const written: string[] = [];
  const stand = await startFakeSlback((seen) =>
    seen.length === 1 ? loginReply("svezhiy") : Response.json({ id: 777 }),
  );
  try {
    const io = ioTo(stand.baseUrl, { onWrite: (text) => written.push(text) });
    const session = openSlback(io, () => 100);
    // Числа возвращаются в обёртке, печатающей исходный текст, поэтому
    // сверяется печать, а не структура (см. `parseJsonVerbatim`).
    expect(JSON.stringify(await session.call("GET", "/admin/client/777"))).toBe(
      '{"id":777}',
    );

    expect(stand.seen.length).toBe(2);
    const [login, call] = stand.seen;
    expect(login.method).toBe("POST");
    expect(login.pathname).toBe("/auth/login");
    expect(login.authorization).toStrictEqual(null);
    expect(login.contentType).toBe("application/json");
    expect(JSON.parse(login.body)).toStrictEqual({
      email: "кто@test",
      password: "пароль",
    });
    expect(call.method).toBe("GET");
    expect(call.pathname).toBe("/admin/client/777");
    // Токен уходит только заголовком авторизации — в ASCII, как того
    // требует HTTP; JWT такой и есть.
    expect(call.authorization).toBe("Bearer svezhiy");
    // Запрос без тела не несёт и заголовка типа содержимого.
    expect(call.contentType).toStrictEqual(null);
    expect(call.body).toBe("");
    expect(written).toStrictEqual([
      JSON.stringify({ token: "svezhiy", expires_at: 700 }),
    ]);
  } finally {
    await stand.stop();
  }
});

it("сбой записи кэша не роняет вызов: токен уже получен", async () => {
  const stand = await startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : Response.json({ ok: true }),
  );
  try {
    const io = {
      ...ioTo(stand.baseUrl),
      writeTokenCache: () => Promise.reject(new Error("нет прав на каталог")),
    };
    expect(await openSlback(io).call("GET", "/admin/roles")).toStrictEqual({
      ok: true,
    });
  } finally {
    await stand.stop();
  }
});

it("логин без accessToken — свой класс отказа и тело в тексте", async () => {
  const stand = await startFakeSlback(() => Response.json({ user: { id: 1 } }));
  try {
    const err = await rejected(
      () => openSlback(ioTo(stand.baseUrl)).token(),
      NoAccessTokenError,
    );
    expect(err.message).toBe(
      'sl-back login: нет accessToken в ответе: {"user":{"id":1}}',
    );
  } finally {
    await stand.stop();
  }
});

it("HTTP ≥ 400 — отказ с кодом и сохранённым телом", async () => {
  const stand = await startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : new Response("client not found", { status: 404 }),
  );
  try {
    const err = await rejected(
      () => openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/client/1"),
      SlbackError,
    );
    expect(err.message).toBe("GET /admin/client/1 failed: HTTP 404");
    expect(err.status).toBe(404);
    expect(err.body).toBe("client not found");
  } finally {
    await stand.stop();
  }
});

it("2xx с HTML-телом — non-JSON, несмотря на успешный статус", async () => {
  const stand = await startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : new Response("<html>вход</html>"),
  );
  try {
    const err = await rejected(
      () => openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/roles"),
      SlbackError,
    );
    expect(err.message).toBe(
      "GET /admin/roles: non-JSON response: <html>вход</html>",
    );
  } finally {
    await stand.stop();
  }
});

it("2xx с пустым телом — нет данных, а не ошибка", async () => {
  const stand = await startFakeSlback((seen) =>
    seen.length === 1 ? loginReply() : new Response(null, { status: 204 }),
  );
  try {
    expect(
      await openSlback(ioTo(stand.baseUrl)).call("GET", "/admin/roles"),
    ).toStrictEqual(undefined);
  } finally {
    await stand.stop();
  }
});

it("обрезка считает байты, а не символы, с обеих сторон", () => {
  // Пять кириллических символов — десять байт: под предел 10 текст
  // проходит целиком, под 9 уже нет.
  expect(truncate("ровно", 10)).toBe("ровно");
  expect(truncate("ровно", 9)).toBe("ровн…(+2 bytes)");
  expect(truncate("abc", 3)).toBe("abc");
  expect(truncate("abcde", 3)).toBe("abc…(+2 bytes)");
});

it("разрез не приходится на середину символа", () => {
  // Предел 3 байта: два кириллических символа не влезают, один влезает
  // с запасом в байт — лучше отдать байт, чем половину буквы.
  expect(truncate("абв", 3)).toBe("а…(+4 bytes)");
});

it("числа ответа печатаются как пришли, без потери точности", async () => {
  const stand = await startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : new Response('{"id":123456789012345678901,"ratio":1.0}', {
          headers: { "content-type": "application/json" },
        }),
  );
  try {
    const response = await openSlback(ioTo(stand.baseUrl)).call(
      "GET",
      "/admin/client/1",
    );
    expect(JSON.stringify(response)).toBe(
      '{"id":123456789012345678901,"ratio":1.0}',
    );
  } finally {
    await stand.stop();
  }
});

it("нет адреса — отказ до сети, у вызова и у логина", async () => {
  const io = ioTo("", { env: { BASE_API_URL: "" } });
  for (const attempt of [
    () => openSlback(io).call("GET", "/admin/roles"),
    () => openSlback(io).token(),
  ]) {
    const err = await rejected(attempt, DomainError);
    expect(err.message).toContain("sl-back base URL не задан");
  }
});

it("живой кэш адреса не спрашивает: за токеном идти некуда", async () => {
  // Обратная сторона предыдущего: команде, которой хватило кэша, база
  // не нужна, и отказывать ей незачем.
  const io = ioTo("", {
    env: { BASE_API_URL: "" },
    cache: JSON.stringify({ token: "из-кэша", expires_at: 2000 }),
  });
  expect(await openSlback(io, () => 1999).token()).toBe("из-кэша");
});

it("тело отказа режется на 500 символов, не-JSON — на 200", async () => {
  const long = "я".repeat(700);
  const stand = await startFakeSlback((seen) =>
    seen.length === 1
      ? loginReply()
      : seen.length === 2
        ? new Response(long, { status: 400 })
        : new Response(long),
  );
  try {
    const session = openSlback(ioTo(stand.baseUrl));
    const failed = await rejected(
      () => session.call("GET", "/admin/roles"),
      SlbackError,
    );
    expect(failed.body).toStrictEqual(truncate(long, 500));
    // 500 байт — это 250 кириллических символов, а не 500.
    expect(failed.body.startsWith("я".repeat(250) + "…(+")).toBe(true);

    const nonJson = await rejected(
      () => session.call("GET", "/admin/roles"),
      SlbackError,
    );
    expect(nonJson.message).toContain(
      `non-JSON response: ${truncate(long, 200)}`,
    );
  } finally {
    await stand.stop();
  }
});

it("транспортный сбой называет метод, путь и причину одной строкой", async () => {
  const stand = await startFakeSlback(() => loginReply());
  const baseUrl = stand.baseUrl;
  await stand.stop();
  const err = await rejected(
    () => openSlback(ioTo(baseUrl)).token(),
    SlbackError,
  );
  expect(err.message).toContain("POST /auth/login failed: transport error: ");
  expect(err.message.split("\n").length).toBe(1);
});
