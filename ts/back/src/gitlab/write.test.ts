/**
 * Пишущие вызовы GitLab (`platform/gitlab-api.md`): форма тела, пути,
 * query резолва и разбор ответов.
 *
 * Главное здесь — что тело form-urlencoded, а position идёт скобочными
 * ключами. Вложенным JSON инсталляция GitLab position молча
 * игнорирует: комментарий создаётся БЕЗ привязки к строке, и вызов при
 * этом успешен — промах выглядит как успех (отклонение preserve).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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
import { type FakeGitlab, startFakeGitlab } from "./testing.ts";

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

it("создание треда: form-urlencoded и скобочные ключи позиции", async () => {
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
    expect(created.id).toStrictEqual(THREAD_ID);
    // Позиция дошла — тред несёт её и тип DiffNote.
    expect(created.position?.new_line).toBe(8);

    const sent = stand.seen[0];
    expect(sent.method).toBe("POST");
    expect(sent.pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456/discussions",
    );
    expect(sent.contentType).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent.body);
    expect(form.get("position[new_line]")).toBe("8");
    expect(form.get("position[position_type]")).toBe("text");
    // Тело — не JSON: именно эта форма и доносит привязку.
    expect(sent.body.startsWith("{")).toBe(false);
  } finally {
    await stand.stop();
  }
});

it("тело уходит дословно, вместе с хвостовым переводом строки", async () => {
  const stand = startFakeGitlab(() => Response.json(NOTE));
  try {
    await replyToDiscussion(
      access(stand.baseUrl),
      ADDRESS,
      THREAD_ID,
      "ответ\nвторой строкой\n",
    );
    // Ни trim, ни дописывание: что набрал оператор, то и уходит.
    expect(new URLSearchParams(stand.seen[0].body).get("body")).toBe(
      "ответ\nвторой строкой\n",
    );
    expect(stand.seen[0].pathname).toStrictEqual(
      `/api/v4/projects/group%2Frepo/merge_requests/456/discussions/${THREAD_ID}/notes`,
    );
  } finally {
    await stand.stop();
  }
});

describe("резолв: признак идёт query-параметром, тело пустое", () => {
  let stand: FakeGitlab;

  beforeAll(async () => {
    stand = startFakeGitlab(() => Response.json({ id: THREAD_ID }));
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
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("метод и путь", () => {
    expect(stand.seen[0].method).toBe("PUT");
    expect(stand.seen[0].pathname).toStrictEqual(
      `/api/v4/projects/group%2Frepo/merge_requests/456/discussions/${THREAD_ID}`,
    );
  });

  it("resolved=true и resolved=false", () => {
    expect(stand.seen[0].search).toBe("?resolved=true");
    expect(stand.seen[1].search).toBe("?resolved=false");
    expect(stand.seen[0].body).toBe("");
  });
});

it("правка ноты идёт на тот номер, который набрал оператор", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ ...NOTE, body: "новое" })
  );
  try {
    const note = await updateNote(access(stand.baseUrl), ADDRESS, 42, "новое");
    expect(note.body).toBe("новое");
    expect(stand.seen[0].method).toBe("PUT");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456/notes/42",
    );
  } finally {
    await stand.stop();
  }
});

it("чужая нота: 403 GitLab — отказ, а не успех", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"403 Forbidden"}`, { status: 403 })
  );
  try {
    const err = await rejected(
      () => updateNote(access(stand.baseUrl), ADDRESS, 42, "новое"),
      GitlabError,
    );
    expect(err.status).toBe(403);
  } finally {
    await stand.stop();
  }
});

it("удаление: пустое тело ответа — успех, а не отказ разбора", async () => {
  const stand = startFakeGitlab(() => new Response(null, { status: 204 }));
  try {
    await deleteNote(access(stand.baseUrl), ADDRESS, 6);
    expect(stand.seen[0].method).toBe("DELETE");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456/notes/6",
    );
  } finally {
    await stand.stop();
  }
});

it("описание заменяется целиком; ответ — сам MR", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ iid: 456, web_url: "https://gitlab.example.test/x" })
  );
  try {
    const mr = await updateDescription(access(stand.baseUrl), ADDRESS, "текст");
    expect(mr.web_url).toBe("https://gitlab.example.test/x");
    expect(stand.seen[0].method).toBe("PUT");
    expect(new URLSearchParams(stand.seen[0].body).get("description")).toBe(
      "текст",
    );
  } finally {
    await stand.stop();
  }
});

describe("создание MR: пустое описание не отправляется вовсе", () => {
  let stand: FakeGitlab;

  beforeAll(async () => {
    stand = startFakeGitlab(() => Response.json({ iid: 7 }));
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
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("без описания ключа нет", () => {
    const form = new URLSearchParams(stand.seen[0].body);
    expect(form.has("description")).toBe(false);
    expect(form.get("source_branch")).toBe("feat/x");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests",
    );
  });

  it("с описанием ключ есть", () => {
    expect(new URLSearchParams(stand.seen[1].body).get("description")).toBe(
      "тело",
    );
  });
});

it("ответ POST без нот — отказ: пустой успех неотличим от промаха", async () => {
  const stand = startFakeGitlab(() =>
    Response.json({ id: THREAD_ID, notes: [] })
  );
  try {
    await rejected(
      () => createDiscussion(access(stand.baseUrl), ADDRESS, { body: "x" }),
      GitlabError,
      "ответ без нот дискуссии",
    );
  } finally {
    await stand.stop();
  }
});
