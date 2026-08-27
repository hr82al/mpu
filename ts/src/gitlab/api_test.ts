/**
 * Вызовы GitLab по имени (`platform/gitlab-api.md`, таблица
 * эндпоинтов): пути, обязательные параметры и порядок элементов.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { changedFiles, discussions, mergeRequest } from "./api.ts";
import { type GitlabAccess, GitlabError } from "./http.ts";
import { startFakeGitlab } from "./testing.ts";

const ADDRESS = { project: "group/repo", iid: 456 };
const access = (baseUrl: string): GitlabAccess => ({ baseUrl, token: "t" });

Deno.test("шапка MR: путь с URL-encoded project", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ iid: 456, title: "заголовок", author: { username: "u" } })
  );
  try {
    const mr = await mergeRequest(access(stand.baseUrl), ADDRESS);
    assertEquals(mr.project, "group/repo");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
    assertEquals(stand.seen[0].search, "");
  } finally {
    await stand.stop();
  }
});

Deno.test("файлы: только /changes и только с access_raw_diffs", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({
      changes: [
        { new_path: "b.ts", old_path: "b.ts", diff: "@@ -1,1 +1,1 @@\n+a\n" },
        { new_path: "a.ts", old_path: "a.ts", diff: "" },
      ],
    })
  );
  try {
    const files = await changedFiles(access(stand.baseUrl), ADDRESS);
    // Порядок ответа API сохраняется: сортировать нечем — у файлов нет
    // ключа, по которому оператор ждал бы другой порядок.
    assertEquals(files.map((f) => f.new_path), ["b.ts", "a.ts"]);
    assertEquals(files[0].additions, 1);
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456/changes",
    );
    // Без параметра часть файлов пришла бы свёрнутой, с пустым diff, —
    // и счётчики молча стали бы нулями.
    assertEquals(stand.seen[0].search, "?access_raw_diffs=true");
  } finally {
    await stand.stop();
  }
});

Deno.test("треды: пагинировано и в порядке ответа", async () => {
  const page = (ids: readonly string[]) =>
    ids.map((id) => ({
      id,
      notes: [{ id: 1, body: "тело", author: { username: "u" } }],
    }));
  const stand = startFakeGitlab((seen) =>
    Response.json(
      seen.length === 1
        ? page(Array.from({ length: 100 }, (_, i) => `id${i}`))
        : page(["last"]),
    )
  );
  try {
    const threads = await discussions(access(stand.baseUrl), ADDRESS);
    assertEquals(threads.length, 101);
    assertEquals(threads[0].id, "id0");
    assertEquals(threads[100].id, "last");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456/discussions",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("/changes без ключа changes — отказ, а не «MR без файлов»", async () => {
  // 200-ответ не той формы (обрезан прокси, сменилось API) молча
  // означал бы «ревьюить нечего» — худший из возможных ответов.
  const stand = startFakeGitlab(() => Response.json({ message: "ok" }));
  try {
    await assertRejects(
      () => changedFiles(access(stand.baseUrl), ADDRESS),
      GitlabError,
      "ожидался массив в ответе",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("changes: [] — пустой MR, это не отказ", async () => {
  const stand = startFakeGitlab(() => Response.json({ changes: [] }));
  try {
    assertEquals(await changedFiles(access(stand.baseUrl), ADDRESS), []);
  } finally {
    await stand.stop();
  }
});
