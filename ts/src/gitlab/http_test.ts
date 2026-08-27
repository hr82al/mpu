/**
 * Транспорт GitLab (`platform/gitlab-api.md`, «HTTP-клиент»): адрес и
 * заголовки запроса, форма отказа не-2xx и сетевого сбоя, пагинация до
 * страницы короче ста.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  asObject,
  type GitlabAccess,
  GitlabError,
  gitlabGet,
  gitlabGetAll,
  TIMEOUTS,
} from "./http.ts";
import { startFakeGitlab } from "./testing.ts";

const TOKEN = "glpat-proba-Q3z8NwToken";

const accessTo = (baseUrl: string): GitlabAccess => ({ baseUrl, token: TOKEN });

Deno.test("GET: путь от /api/v4, PRIVATE-TOKEN и Accept", async () => {
  const stand = startFakeGitlab(() => Response.json({ iid: 456 }));
  try {
    const body = await gitlabGet(
      accessTo(stand.baseUrl),
      "/projects/group%2Frepo/merge_requests/456",
    );
    assertEquals(asObject(body, "/x").iid, 456);
    assertEquals(stand.seen[0].method, "GET");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
    assertEquals(stand.seen[0].privateToken, TOKEN);
    assertEquals(stand.seen[0].accept, "application/json");
  } finally {
    await stand.stop();
  }
});

Deno.test("не-2xx: метод, путь, код и тело до 300 символов", async () => {
  const long = "x".repeat(400);
  const stand = startFakeGitlab(() => new Response(long, { status: 404 }));
  try {
    const err = await assertRejects(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p/merge_requests/9"),
      GitlabError,
    );
    assertEquals(err.status, 404);
    assertEquals(
      err.message,
      `gitlab GET /projects/p/merge_requests/9 -> 404: ${"x".repeat(300)}`,
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("сетевой сбой: статус 0 и текст сбоя вместо тела", async () => {
  const stand = startFakeGitlab(() => new Response("", { status: 200 }));
  const baseUrl = stand.baseUrl;
  // Сервер погашен до вызова: соединение не устанавливается вовсе.
  await stand.stop();
  const err = await assertRejects(
    () => gitlabGet(accessTo(baseUrl), "/projects/p/merge_requests/9"),
    GitlabError,
  );
  assertEquals(err.status, 0);
  assertStringIncludes(err.message, "-> 0: ");
});

Deno.test("пагинация идёт дальше страницы ровно в сто элементов", async () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: from + index }));
  const stand = startFakeGitlab((seen) =>
    Response.json(seen.length === 1 ? page(1, 100) : page(101, 7))
  );
  try {
    const items = await gitlabGetAll(
      accessTo(stand.baseUrl),
      "/projects/p/merge_requests/9/discussions",
    );
    // Ровно сто означают «может быть ещё»: остановка на первой
    // странице теряла бы треды активного MR молча.
    assertEquals(items.length, 107);
    assertEquals(items[106].id, 107);
    assertEquals(stand.seen.length, 2);
    assertEquals(stand.seen[0].search, "?per_page=100&page=1");
    assertEquals(stand.seen[1].search, "?per_page=100&page=2");
  } finally {
    await stand.stop();
  }
});

Deno.test("длина страницы считается по ответу, а не по пережившим отбор", async () => {
  // Один не-объект в сотне элементов иначе выглядел бы как «страница
  // короче ста», и следующие страницы потерялись бы молча.
  const dirty = [
    ...Array.from({ length: 99 }, (_, index) => ({ id: index })),
    "мусор",
  ];
  const stand = startFakeGitlab((seen) =>
    Response.json(seen.length === 1 ? dirty : [{ id: 100 }])
  );
  try {
    const items = await gitlabGetAll(accessTo(stand.baseUrl), "/x");
    assertEquals(items.length, 100);
    assertEquals(stand.seen.length, 2);
  } finally {
    await stand.stop();
  }
});

Deno.test("токен не появляется ни в одном тексте отказа", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"401 Unauthorized"}`, { status: 401 })
  );
  try {
    const err = await assertRejects(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p/merge_requests/9"),
      GitlabError,
    );
    assertEquals(err.message.includes(TOKEN), false);
    // И в отказе разбора тела тоже: сообщения собираются из метода,
    // пути и тела ответа, а не из запроса целиком.
    assertEquals(String(err.stack).includes(TOKEN), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("ответ не JSON и не той формы — отказ разбора, не молчание", async () => {
  const stand = startFakeGitlab(() => new Response("<html>", { status: 200 }));
  try {
    await assertRejects(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p"),
      GitlabError,
      "не разбирается как JSON",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("предел не отбивает ответ, над которым сервер думает", async () => {
  // Десять секунд спеки отмеряют СОЕДИНЕНИЕ; наш транспорт умеет только
  // «ждать заголовков», то есть время раздумья сервера. Приложив
  // десятку к нему, мы падали бы там, где рабочая версия дотерпит:
  // /discussions активного MR отвечает за шесть секунд.
  assertEquals(TIMEOUTS.headersTimeoutMs, TIMEOUTS.totalTimeoutMs);
  assertEquals(TIMEOUTS.totalTimeoutMs, 30_000);

  const slow = startFakeGitlab(async () => {
    // Задержка заголовков, а не тела: столько сервер «думает».
    await new Promise((resolve) => setTimeout(resolve, 120));
    return Response.json({ iid: 1 });
  });
  try {
    const body = await gitlabGet(accessTo(slow.baseUrl), "/projects/p");
    assertEquals(asObject(body, "/x").iid, 1);
  } finally {
    await slow.stop();
  }
});
