/**
 * Транспорт GitLab (`platform/gitlab-api.md`, «HTTP-клиент»): адрес и
 * заголовки запроса, форма отказа не-2xx и сетевого сбоя, пагинация до
 * страницы короче ста.
 */

import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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

it("GET: путь от /api/v4, PRIVATE-TOKEN и Accept", async () => {
  const stand = await startFakeGitlab(() => Response.json({ iid: 456 }));
  try {
    const body = await gitlabGet(
      accessTo(stand.baseUrl),
      "/projects/group%2Frepo/merge_requests/456",
    );
    expect(asObject(body, "/x").iid).toBe(456);
    expect(stand.seen[0].method).toBe("GET");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
    expect(stand.seen[0].privateToken).toStrictEqual(TOKEN);
    expect(stand.seen[0].accept).toBe("application/json");
  } finally {
    await stand.stop();
  }
});

it("не-2xx: метод, путь, код и тело до 300 символов", async () => {
  const long = "x".repeat(400);
  const stand = await startFakeGitlab(() =>
    new Response(long, { status: 404 })
  );
  try {
    const err = await rejected(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p/merge_requests/9"),
      GitlabError,
    );
    expect(err.status).toBe(404);
    expect(err.message).toStrictEqual(
      `gitlab GET /projects/p/merge_requests/9 -> 404: ${"x".repeat(300)}`,
    );
  } finally {
    await stand.stop();
  }
});

it("сетевой сбой: статус 0 и текст сбоя вместо тела", async () => {
  const stand = await startFakeGitlab(() => new Response("", { status: 200 }));
  const baseUrl = stand.baseUrl;
  // Сервер погашен до вызова: соединение не устанавливается вовсе.
  await stand.stop();
  const err = await rejected(
    () => gitlabGet(accessTo(baseUrl), "/projects/p/merge_requests/9"),
    GitlabError,
  );
  expect(err.status).toBe(0);
  expect(err.message).toContain("-> 0: ");
});

it("пагинация идёт дальше страницы ровно в сто элементов", async () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: from + index }));
  const stand = await startFakeGitlab((seen) =>
    Response.json(seen.length === 1 ? page(1, 100) : page(101, 7))
  );
  try {
    const items = await gitlabGetAll(
      accessTo(stand.baseUrl),
      "/projects/p/merge_requests/9/discussions",
    );
    // Ровно сто означают «может быть ещё»: остановка на первой
    // странице теряла бы треды активного MR молча.
    expect(items.length).toBe(107);
    expect(items[106].id).toBe(107);
    expect(stand.seen.length).toBe(2);
    expect(stand.seen[0].search).toBe("?per_page=100&page=1");
    expect(stand.seen[1].search).toBe("?per_page=100&page=2");
  } finally {
    await stand.stop();
  }
});

it("длина страницы считается по ответу, а не по пережившим отбор", async () => {
  // Один не-объект в сотне элементов иначе выглядел бы как «страница
  // короче ста», и следующие страницы потерялись бы молча.
  const dirty = [
    ...Array.from({ length: 99 }, (_, index) => ({ id: index })),
    "мусор",
  ];
  const stand = await startFakeGitlab((seen) =>
    Response.json(seen.length === 1 ? dirty : [{ id: 100 }])
  );
  try {
    const items = await gitlabGetAll(accessTo(stand.baseUrl), "/x");
    expect(items.length).toBe(100);
    expect(stand.seen.length).toBe(2);
  } finally {
    await stand.stop();
  }
});

it("токен не появляется ни в одном тексте отказа", async () => {
  const stand = await startFakeGitlab(() =>
    new Response(`{"message":"401 Unauthorized"}`, { status: 401 })
  );
  try {
    const err = await rejected(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p/merge_requests/9"),
      GitlabError,
    );
    expect(err.message.includes(TOKEN)).toBe(false);
    // И в отказе разбора тела тоже: сообщения собираются из метода,
    // пути и тела ответа, а не из запроса целиком.
    expect(String(err.stack).includes(TOKEN)).toBe(false);
  } finally {
    await stand.stop();
  }
});

it("ответ не JSON и не той формы — отказ разбора, не молчание", async () => {
  const stand = await startFakeGitlab(() =>
    new Response("<html>", { status: 200 })
  );
  try {
    await rejected(
      () => gitlabGet(accessTo(stand.baseUrl), "/projects/p"),
      GitlabError,
      "не разбирается как JSON",
    );
  } finally {
    await stand.stop();
  }
});

it("предел не отбивает ответ, над которым сервер думает", async () => {
  // Десять секунд спеки отмеряют СОЕДИНЕНИЕ; наш транспорт умеет только
  // «ждать заголовков», то есть время раздумья сервера. Приложив
  // десятку к нему, мы падали бы там, где рабочая версия дотерпит:
  // /discussions активного MR отвечает за шесть секунд.
  expect(TIMEOUTS.headersTimeoutMs).toStrictEqual(TIMEOUTS.totalTimeoutMs);
  expect(TIMEOUTS.totalTimeoutMs).toBe(30_000);

  const slow = await startFakeGitlab(async () => {
    // Задержка заголовков, а не тела: столько сервер «думает».
    await new Promise((resolve) => setTimeout(resolve, 120));
    return Response.json({ iid: 1 });
  });
  try {
    const body = await gitlabGet(accessTo(slow.baseUrl), "/projects/p");
    expect(asObject(body, "/x").iid).toBe(1);
  } finally {
    await slow.stop();
  }
});
