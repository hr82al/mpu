/**
 * Пишущие вызовы GitLab (`platform/gitlab-api.md`): форма тела, пути,
 * query резолва и разбор ответов.
 *
 * Главное здесь — что тело form-urlencoded, а position идёт скобочными
 * ключами. Вложенным JSON инсталляция GitLab position молча
 * игнорирует: комментарий создаётся БЕЗ привязки к строке, и вызов при
 * этом успешен — промах выглядит как успех (отклонение preserve).
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  createDiscussion,
  createMergeRequest,
  deleteNote,
  replyToDiscussion,
  setDiscussionResolved,
  updateDescription,
  updateNote,
} from "./api.ts";
import { type GitlabAccess, GitlabError } from "./http.ts";
import { startFakeGitlab } from "./testing.ts";

const ADDRESS = { project: "group/repo", iid: 456 };
const access = (baseUrl: string): GitlabAccess => ({ baseUrl, token: "t" });
const THREAD_ID = "a1b2c3d400000000000000000000000000000000";

const NOTE = {
  id: 6,
  body: "замечание к строке",
  author: { name: "Имя Фамилия", username: "user" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  system: false,
  resolvable: true,
  resolved: false,
  type: "DiffNote",
  position: {
    old_path: "src/module.txt",
    new_path: "src/module.txt",
    old_line: 8,
    new_line: 8,
  },
};

Deno.test("создание треда: form-urlencoded и скобочные ключи позиции", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ id: THREAD_ID, notes: [NOTE] })
  );
  try {
    const created = await createDiscussion(access(stand.baseUrl), ADDRESS, {
      body: "замечание к строке",
      "position[position_type]": "text",
      "position[new_path]": "src/module.txt",
      "position[new_line]": "8",
    });
    assertEquals(created.id, THREAD_ID);
    // Позиция дошла — тред несёт её и тип DiffNote.
    assertEquals(created.position?.new_line, 8);

    const sent = stand.seen[0];
    assertEquals(sent.method, "POST");
    assertEquals(
      sent.pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456/discussions",
    );
    assertEquals(sent.contentType, "application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent.body);
    assertEquals(form.get("position[new_line]"), "8");
    assertEquals(form.get("position[position_type]"), "text");
    // Тело — не JSON: именно эта форма и доносит привязку.
    assertEquals(sent.body.startsWith("{"), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("тело уходит дословно, вместе с хвостовым переводом строки", async () => {
  const stand = startFakeGitlab(() => Response.json(NOTE));
  try {
    await replyToDiscussion(
      access(stand.baseUrl),
      ADDRESS,
      THREAD_ID,
      "ответ\nвторой строкой\n",
    );
    // Ни trim, ни дописывание: что набрал оператор, то и уходит.
    assertEquals(
      new URLSearchParams(stand.seen[0].body).get("body"),
      "ответ\nвторой строкой\n",
    );
    assertEquals(
      stand.seen[0].pathname,
      `/api/v4/projects/group%2Frepo/merge_requests/456/discussions/${THREAD_ID}/notes`,
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("резолв: признак идёт query-параметром, тело пустое", async (t) => {
  const stand = startFakeGitlab(() => Response.json({ id: THREAD_ID }));
  try {
    await setDiscussionResolved(
      access(stand.baseUrl),
      ADDRESS,
      THREAD_ID,
      true,
    );
    await setDiscussionResolved(
      access(stand.baseUrl),
      ADDRESS,
      THREAD_ID,
      false,
    );

    await t.step("метод и путь", () => {
      assertEquals(stand.seen[0].method, "PUT");
      assertEquals(
        stand.seen[0].pathname,
        `/api/v4/projects/group%2Frepo/merge_requests/456/discussions/${THREAD_ID}`,
      );
    });

    await t.step("resolved=true и resolved=false", () => {
      assertEquals(stand.seen[0].search, "?resolved=true");
      assertEquals(stand.seen[1].search, "?resolved=false");
      assertEquals(stand.seen[0].body, "");
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("правка ноты идёт на тот номер, который набрал оператор", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ ...NOTE, body: "новое" })
  );
  try {
    const note = await updateNote(access(stand.baseUrl), ADDRESS, 42, "новое");
    assertEquals(note.body, "новое");
    assertEquals(stand.seen[0].method, "PUT");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456/notes/42",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("чужая нота: 403 GitLab — отказ, а не успех", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"403 Forbidden"}`, { status: 403 })
  );
  try {
    const err = await assertRejects(
      () => updateNote(access(stand.baseUrl), ADDRESS, 42, "новое"),
      GitlabError,
    );
    assertEquals(err.status, 403);
  } finally {
    await stand.stop();
  }
});

Deno.test("удаление: пустое тело ответа — успех, а не отказ разбора", async () => {
  const stand = startFakeGitlab(() => new Response(null, { status: 204 }));
  try {
    await deleteNote(access(stand.baseUrl), ADDRESS, 6);
    assertEquals(stand.seen[0].method, "DELETE");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456/notes/6",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("описание заменяется целиком; ответ — сам MR", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ iid: 456, web_url: "https://gitlab.example.test/x" })
  );
  try {
    const mr = await updateDescription(access(stand.baseUrl), ADDRESS, "текст");
    assertEquals(mr.web_url, "https://gitlab.example.test/x");
    assertEquals(stand.seen[0].method, "PUT");
    assertEquals(
      new URLSearchParams(stand.seen[0].body).get("description"),
      "текст",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("создание MR: пустое описание не отправляется вовсе", async (t) => {
  const stand = startFakeGitlab(() => Response.json({ iid: 7 }));
  try {
    await createMergeRequest(access(stand.baseUrl), "group/repo", {
      source_branch: "feat/x",
      target_branch: "main",
      title: "заголовок",
      description: "",
    });
    await createMergeRequest(access(stand.baseUrl), "group/repo", {
      source_branch: "feat/x",
      target_branch: "main",
      title: "заголовок",
      description: "тело",
    });

    await t.step("без описания ключа нет", () => {
      const form = new URLSearchParams(stand.seen[0].body);
      assertEquals(form.has("description"), false);
      assertEquals(form.get("source_branch"), "feat/x");
      assertEquals(
        stand.seen[0].pathname,
        "/api/v4/projects/group%2Frepo/merge_requests",
      );
    });

    await t.step("с описанием ключ есть", () => {
      assertEquals(
        new URLSearchParams(stand.seen[1].body).get("description"),
        "тело",
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("ответ POST без нот — отказ: пустой успех неотличим от промаха", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ id: THREAD_ID, notes: [] })
  );
  try {
    await assertRejects(
      () => createDiscussion(access(stand.baseUrl), ADDRESS, { body: "x" }),
      GitlabError,
      "ответ без нот дискуссии",
    );
  } finally {
    await stand.stop();
  }
});
