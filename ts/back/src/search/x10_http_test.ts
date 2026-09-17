/**
 * Транспорт 10X (`docs/specs/search.md`, «HTTP и кэш токенов»):
 * `x10BaseUrl` и `x10Call` без сети — отправитель `X10Send` подменяется
 * фейком, проверяющим метод/путь/заголовки и отдающим заготовленный
 * ответ (как договорено с сессией-заказчиком тестов).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import {
  type EnvKeys,
  x10BaseUrl,
  x10Call,
  X10StatusError,
} from "./x10_http.ts";

/** Env-файл с ровно названными ключами; остальные — «нет ключа». */
function envOf(values: Readonly<Record<string, string>>): EnvKeys {
  return { get: (name) => values[name] };
}

/* --------------------------------------------------------------- *
 * x10BaseUrl
 * --------------------------------------------------------------- */

Deno.test("x10BaseUrl: X10_URL старше X10_API_URL", () => {
  assertEquals(
    x10BaseUrl(
      envOf({
        X10_URL: "https://from-url.example",
        X10_API_URL: "https://from-api-url.example",
      }),
    ),
    "https://from-url.example/api",
  );
});

Deno.test("x10BaseUrl: ни одна переменная не задана — дефолт", () => {
  assertEquals(x10BaseUrl(envOf({})), "https://app.system10x.ru/api");
});

Deno.test("x10BaseUrl: пустая строка равнозначна отсутствию ключа", () => {
  assertEquals(
    x10BaseUrl(
      envOf({ X10_URL: "", X10_API_URL: "https://from-api-url.example" }),
    ),
    "https://from-api-url.example/api",
  );
});

Deno.test("x10BaseUrl: хвостовые / отрезаются, суффикс /api добавляется", () => {
  assertEquals(
    x10BaseUrl(envOf({ X10_URL: "https://x10.example///" })),
    "https://x10.example/api",
  );
});

Deno.test("x10BaseUrl: суффикс /api не дублируется", () => {
  assertEquals(
    x10BaseUrl(envOf({ X10_URL: "https://x10.example/api" })),
    "https://x10.example/api",
  );
});

Deno.test("x10BaseUrl: суффикс /api не дублируется при хвостовом /", () => {
  assertEquals(
    x10BaseUrl(envOf({ X10_URL: "https://x10.example/api/" })),
    "https://x10.example/api",
  );
});

/* --------------------------------------------------------------- *
 * x10Call: успех, заголовки, разбор обёртки
 * --------------------------------------------------------------- */

Deno.test("x10Call: успешный ответ — берётся data обёртки", async () => {
  const data = await x10Call(
    "https://x10.example/api",
    { method: "GET", path: "/workspaces", token: "tok-1" },
    () =>
      Promise.resolve({
        status: 200,
        text: JSON.stringify({
          success: true,
          message: "OK",
          data: [{ id: 1 }],
        }),
      }),
  );
  assertEquals(data, [{ id: 1 }]);
});

Deno.test("x10Call: заголовки — accept всегда, authorization при токене", async () => {
  let seenHeaders: Readonly<Record<string, string>> | undefined;
  await x10Call(
    "https://x10.example/api",
    { method: "GET", path: "/workspaces", token: "secret-tok" },
    (_url, init) => {
      seenHeaders = init.headers;
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ success: true, message: "OK", data: {} }),
      });
    },
  );
  assertEquals(seenHeaders?.accept, "application/json");
  assertEquals(seenHeaders?.authorization, "Bearer secret-tok");
});

Deno.test("x10Call: без токена authorization не выставляется", async () => {
  let seenHeaders: Readonly<Record<string, string>> | undefined;
  await x10Call(
    "https://x10.example/api",
    {
      method: "POST",
      path: "/auth/login",
      body: { email: "a", password: "b" },
    },
    (_url, init) => {
      seenHeaders = init.headers;
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({
          success: true,
          message: "OK",
          data: { access_token: "t" },
        }),
      });
    },
  );
  assertEquals(seenHeaders?.authorization, undefined);
  assertEquals(seenHeaders?.accept, "application/json");
});

Deno.test("x10Call: путь и URL склеены из базы и path", async () => {
  let seenUrl: URL | undefined;
  await x10Call(
    "https://x10.example/api",
    { method: "GET", path: "/users/staff/search?query=a%40b.c" },
    (url) => {
      seenUrl = url;
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ success: true, message: "OK", data: [] }),
      });
    },
  );
  assertEquals(
    seenUrl?.toString(),
    "https://x10.example/api/users/staff/search?query=a%40b.c",
  );
});

/* --------------------------------------------------------------- *
 * x10Call: отказы
 * --------------------------------------------------------------- */

Deno.test("x10Call: non-2xx — HTTP <код> с методом и путём", async () => {
  const err = await assertRejects(
    () =>
      x10Call(
        "https://x10.example/api",
        { method: "GET", path: "/workspaces", token: "tok" },
        () => Promise.resolve({ status: 404, text: "not found" }),
      ),
    X10StatusError,
  );
  assertEquals(err.message, "GET /workspaces: HTTP 404");
  assertEquals(err.status, 404);
});

Deno.test("x10Call: сетевой сбой — transport error с деталями", async () => {
  const err = await assertRejects(
    () =>
      x10Call(
        "https://x10.example/api",
        { method: "POST", path: "/auth/login", body: {} },
        () => {
          throw new Error("connection refused");
        },
      ),
    DomainError,
  );
  assertEquals(
    err.message,
    "POST /auth/login: transport error: connection refused",
  );
});

Deno.test("x10Call: тело не JSON — внятный отказ", async () => {
  const err = await assertRejects(
    () =>
      x10Call(
        "https://x10.example/api",
        { method: "GET", path: "/workspaces" },
        () => Promise.resolve({ status: 200, text: "не json вовсе" }),
      ),
    DomainError,
  );
  assertEquals(err.message, "GET /workspaces: ответ не JSON");
});

Deno.test("x10Call: JSON без data — внятный отказ", async () => {
  const err = await assertRejects(
    () =>
      x10Call(
        "https://x10.example/api",
        { method: "GET", path: "/workspaces" },
        () =>
          Promise.resolve({
            status: 200,
            text: JSON.stringify({ success: true, message: "OK" }),
          }),
      ),
    DomainError,
  );
  assertEquals(err.message, "GET /workspaces: в ответе нет data");
});

Deno.test("x10Call: JSON-массив (не объект) — внятный отказ", async () => {
  const err = await assertRejects(
    () =>
      x10Call(
        "https://x10.example/api",
        { method: "GET", path: "/workspaces" },
        () => Promise.resolve({ status: 200, text: "[]" }),
      ),
    DomainError,
  );
  assertEquals(err.message, "GET /workspaces: ответ не объект");
});
