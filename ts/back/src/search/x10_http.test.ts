/**
 * Транспорт 10X (`docs/specs/search.md`, «HTTP и кэш токенов»):
 * `x10BaseUrl` и `x10Call` без сети — отправитель `X10Send` подменяется
 * фейком, проверяющим метод/путь/заголовки и отдающим заготовленный
 * ответ (как договорено с сессией-заказчиком тестов).
 */

import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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

it("x10BaseUrl: X10_URL старше X10_API_URL", () => {
  expect(x10BaseUrl(
    envOf({
      X10_URL: "https://from-url.example",
      X10_API_URL: "https://from-api-url.example",
    }),
  )).toBe("https://from-url.example/api");
});

it("x10BaseUrl: ни одна переменная не задана — дефолт", () => {
  expect(x10BaseUrl(envOf({}))).toBe("https://app.system10x.ru/api");
});

it("x10BaseUrl: пустая строка равнозначна отсутствию ключа", () => {
  expect(x10BaseUrl(
    envOf({ X10_URL: "", X10_API_URL: "https://from-api-url.example" }),
  )).toBe("https://from-api-url.example/api");
});

it("x10BaseUrl: хвостовые / отрезаются, суффикс /api добавляется", () => {
  expect(x10BaseUrl(envOf({ X10_URL: "https://x10.example///" }))).toBe(
    "https://x10.example/api",
  );
});

it("x10BaseUrl: суффикс /api не дублируется", () => {
  expect(x10BaseUrl(envOf({ X10_URL: "https://x10.example/api" }))).toBe(
    "https://x10.example/api",
  );
});

it("x10BaseUrl: суффикс /api не дублируется при хвостовом /", () => {
  expect(x10BaseUrl(envOf({ X10_URL: "https://x10.example/api/" }))).toBe(
    "https://x10.example/api",
  );
});

/* --------------------------------------------------------------- *
 * x10Call: успех, заголовки, разбор обёртки
 * --------------------------------------------------------------- */

it("x10Call: успешный ответ — берётся data обёртки", async () => {
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
  expect(data).toStrictEqual([{ id: 1 }]);
});

it("x10Call: заголовки — accept всегда, authorization при токене", async () => {
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
  expect(seenHeaders?.accept).toBe("application/json");
  expect(seenHeaders?.authorization).toBe("Bearer secret-tok");
});

it("x10Call: без токена authorization не выставляется", async () => {
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
  expect(seenHeaders?.authorization).toStrictEqual(undefined);
  expect(seenHeaders?.accept).toBe("application/json");
});

it("x10Call: путь и URL склеены из базы и path", async () => {
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
  expect(seenUrl?.toString()).toBe(
    "https://x10.example/api/users/staff/search?query=a%40b.c",
  );
});

/* --------------------------------------------------------------- *
 * x10Call: отказы
 * --------------------------------------------------------------- */

it("x10Call: non-2xx — HTTP <код> с методом и путём", async () => {
  const err = await rejected(() =>
    x10Call(
      "https://x10.example/api",
      { method: "GET", path: "/workspaces", token: "tok" },
      () => Promise.resolve({ status: 404, text: "not found" }),
    ), X10StatusError);
  expect(err.message).toBe("GET /workspaces: HTTP 404");
  expect(err.status).toBe(404);
});

it("x10Call: сетевой сбой — transport error с деталями", async () => {
  const err = await rejected(() =>
    x10Call(
      "https://x10.example/api",
      { method: "POST", path: "/auth/login", body: {} },
      () => {
        throw new Error("connection refused");
      },
    ), DomainError);
  expect(err.message).toBe(
    "POST /auth/login: transport error: connection refused",
  );
});

it("x10Call: тело не JSON — внятный отказ", async () => {
  const err = await rejected(() =>
    x10Call(
      "https://x10.example/api",
      { method: "GET", path: "/workspaces" },
      () => Promise.resolve({ status: 200, text: "не json вовсе" }),
    ), DomainError);
  expect(err.message).toBe("GET /workspaces: ответ не JSON");
});

it("x10Call: JSON без data — внятный отказ", async () => {
  const err = await rejected(() =>
    x10Call(
      "https://x10.example/api",
      { method: "GET", path: "/workspaces" },
      () =>
        Promise.resolve({
          status: 200,
          text: JSON.stringify({ success: true, message: "OK" }),
        }),
    ), DomainError);
  expect(err.message).toBe("GET /workspaces: в ответе нет data");
});

it("x10Call: JSON-массив (не объект) — внятный отказ", async () => {
  const err = await rejected(() =>
    x10Call(
      "https://x10.example/api",
      { method: "GET", path: "/workspaces" },
      () => Promise.resolve({ status: 200, text: "[]" }),
    ), DomainError);
  expect(err.message).toBe("GET /workspaces: ответ не объект");
});
