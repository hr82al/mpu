/**
 * Вызовы GitLab по имени (`platform/gitlab-api.md`, таблица
 * эндпоинтов): пути, обязательные параметры и порядок элементов.
 */

import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { changedFiles, discussions, mergeRequest } from "./api.ts";
import { type GitlabAccess, GitlabError } from "./http.ts";
import { startFakeGitlab } from "./testing.ts";

const ADDRESS = { project: "group/repo", iid: 456 };
const access = (baseUrl: string): GitlabAccess => ({ baseUrl, token: "t" });

it("шапка MR: путь с URL-encoded project", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ iid: 456, title: "заголовок", author: { username: "u" } })
  );
  try {
    const mr = await mergeRequest(access(stand.baseUrl), ADDRESS);
    expect(mr.project).toBe("group/repo");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
    expect(stand.seen[0].search).toBe("");
  } finally {
    await stand.stop();
  }
});

it("файлы: только /changes и только с access_raw_diffs", async () => {
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
    expect(files.map((f) => f.new_path)).toStrictEqual(["b.ts", "a.ts"]);
    expect(files[0].additions).toBe(1);
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456/changes",
    );
    // Без параметра часть файлов пришла бы свёрнутой, с пустым diff, —
    // и счётчики молча стали бы нулями.
    expect(stand.seen[0].search).toBe("?access_raw_diffs=true");
  } finally {
    await stand.stop();
  }
});

it("треды: пагинировано и в порядке ответа", async () => {
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
    expect(threads.length).toBe(101);
    expect(threads[0].id).toBe("id0");
    expect(threads[100].id).toBe("last");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456/discussions",
    );
  } finally {
    await stand.stop();
  }
});

it("/changes без ключа changes — отказ, а не «MR без файлов»", async () => {
  // 200-ответ не той формы (обрезан прокси, сменилось API) молча
  // означал бы «ревьюить нечего» — худший из возможных ответов.
  const stand = startFakeGitlab(() => Response.json({ message: "ok" }));
  try {
    await rejected(
      () => changedFiles(access(stand.baseUrl), ADDRESS),
      GitlabError,
      "ожидался массив в ответе",
    );
  } finally {
    await stand.stop();
  }
});

it("changes: [] — пустой MR, это не отказ", async () => {
  const stand = startFakeGitlab(() => Response.json({ changes: [] }));
  try {
    expect(await changedFiles(access(stand.baseUrl), ADDRESS)).toStrictEqual(
      [],
    );
  } finally {
    await stand.stop();
  }
});
