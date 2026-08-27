/**
 * Write-подкоманды `mpu mr` (`docs/specs/mr-write.md`) на подставном
 * GitLab: формы вывода против эталонов канала, проверки до сети и
 * — главное — привязка комментария к строке.
 *
 * Промах здесь выглядит как успех: GitLab принимает POST с неверной
 * позицией и отвечает 201, а комментарий повисает без привязки. Поэтому
 * тесты проверяют не «создалось», а «создалось с позицией»: и по форме
 * отправленного тела, и по тому, что вернулось.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import type { RunGit } from "../gitlab/mod.ts";
import { startFakeGitlab } from "../gitlab/testing.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { renderComment, runComment } from "./cmd_comment.ts";
import { renderCreate, runCreate } from "./cmd_create.ts";
import { renderDelete, runDelete } from "./cmd_delete.ts";
import { renderDescribe, runDescribe } from "./cmd_describe.ts";
import { renderEdit, runEdit } from "./cmd_edit.ts";
import { renderNote, runNote } from "./cmd_note.ts";
import { renderReply, runReply } from "./cmd_reply.ts";
import { renderResolve, runResolve } from "./cmd_resolve.ts";
import { renderShow, runShow } from "./cmd_show.ts";

const TOKEN = "glpat-proba-Q3z8NwToken";
const REF = "group/repo!1";
const THREAD_ID = "a1b2c3d400000000000000000000000000000000";
const WEB_URL = "https://gitlab.example.test/group/repo/-/merge_requests/1";

const noGit: RunGit = () => {
  throw new Error("git must not be run");
};

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/mr-write/${name}`, import.meta.url),
  );
}

function ioTo(baseUrl: string, overrides: Partial<CommandIo> = {}): CommandIo {
  return makeFakeIo({
    cwd: () => "/repo",
    env: (name: string) => (name === "HOME" ? "/home/проба" : undefined),
    envFile: {
      get: (name: string) =>
        name === "GITLAB_BASE_URL"
          ? baseUrl
          : name === "GLAB_TOKEN"
          ? TOKEN
          : undefined,
      require: (name: string) => {
        if (name === "GLAB_TOKEN") return TOKEN;
        throw new DomainError(`нет ключа ${name}`);
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({}),
    },
    ...overrides,
  });
}

const MR_BODY = {
  iid: 1,
  title: "правка одной строки",
  state: "opened",
  source_branch: "feat/change",
  target_branch: "main",
  web_url: WEB_URL,
  author: { name: "Имя Фамилия", username: "user" },
  description: "",
  diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" },
  project_id: 1,
  sha: "head",
};

/** Файл песочницы: правка строки 7 в файле из двадцати строк. */
const FILE_DIFF = [
  "@@ -4,7 +4,7 @@",
  " строка 4",
  " строка 5",
  " строка 6",
  "-старая 7",
  "+новая 7",
  " строка 8",
  " строка 9",
  " строка 10",
].join("\n") + "\n";

const CHANGES = {
  changes: [{
    old_path: "src/module.txt",
    new_path: "src/module.txt",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: FILE_DIFF,
  }],
};

/** Нота, созданная инлайн-комментарием: DiffNote с позицией. */
const DIFF_NOTE = {
  id: 6,
  body: "замечание к строке",
  author: { name: "Имя Фамилия", username: "user" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  system: false,
  resolvable: true,
  resolved: true,
  type: "DiffNote",
  position: {
    old_path: "src/module.txt",
    new_path: "src/module.txt",
    old_line: 8,
    new_line: 8,
  },
};

/**
 * Стенд, отвечающий по методу и пути. `created` — тело ответа на POST
 * треда: тест подменяет его, чтобы показать промах.
 */
function standWith(overrides: Readonly<Record<string, unknown>> = {}) {
  return startFakeGitlab((seen) => {
    const last = seen[seen.length - 1];
    const path = last.pathname;
    if (last.method === "POST" && path.endsWith("/discussions")) {
      return Response.json(
        overrides.created ?? { id: THREAD_ID, notes: [DIFF_NOTE] },
      );
    }
    if (last.method === "POST" && path.endsWith("/notes")) {
      return Response.json({ ...DIFF_NOTE, id: 8, body: "ответ в тред" });
    }
    if (last.method === "POST") return Response.json(overrides.mr ?? MR_BODY);
    if (last.method === "PUT" && path.includes("/notes/")) {
      return Response.json({ ...DIFF_NOTE, id: 6 });
    }
    if (last.method === "PUT" && path.includes("/discussions/")) {
      return Response.json({ id: THREAD_ID });
    }
    if (last.method === "PUT") return Response.json(overrides.mr ?? MR_BODY);
    if (last.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/changes")) {
      return Response.json(overrides.changes ?? CHANGES);
    }
    if (path.endsWith("/discussions")) {
      return Response.json(
        overrides.discussions ?? [{ id: THREAD_ID, notes: [DIFF_NOTE] }],
      );
    }
    return Response.json(overrides.mr ?? MR_BODY);
  });
}

Deno.test("comment: привязка к строке уходит и возвращается", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const result = await runComment(
      {
        target: "src/module.txt:8",
        mr: REF,
        message: "замечание к строке",
        "body-file": undefined,
        old: false,
      },
      io,
      { runGit: noGit },
    );

    await t.step("вывод — эталон канала", async () => {
      assertEquals(
        renderComment(result),
        await golden("comment-created.stdout"),
      );
    });

    await t.step("POST несёт скобочные ключи позиции", () => {
      const post = stand.seen.find((r) => r.method === "POST")!;
      const form = new URLSearchParams(post.body);
      // Строка 8 — контекстная, поэтому позиция несёт ОБА номера:
      // без них GitLab привязку не примет.
      assertEquals(form.get("position[new_line]"), "8");
      assertEquals(form.get("position[old_line]"), "8");
      assertEquals(form.get("position[position_type]"), "text");
      assertEquals(form.get("position[head_sha]"), "head");
      assertEquals(post.contentType, "application/x-www-form-urlencoded");
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("исход comment + reply: тред приходит с позицией", async () => {
  // Стенд с состоянием: он строит ноты из ТОГО, ЧТО ОТПРАВИЛА команда,
  // и отдаёт их обратно в /discussions. Промах — POST без ключей
  // position — дал бы здесь `position: null` и `DiscussionNote`, и
  // голден канала не сошёлся бы: именно так выглядит комментарий,
  // повисший в MR без привязки к строке.
  const notes: unknown[] = [];
  const recording = startFakeGitlab((seen) => {
    const last = seen[seen.length - 1];
    if (last.method === "POST" && last.pathname.endsWith("/discussions")) {
      const form = new URLSearchParams(last.body);
      const position = form.has("position[new_line]") ||
          form.has("position[old_line]")
        ? {
          old_path: form.get("position[old_path]"),
          new_path: form.get("position[new_path]"),
          old_line: numberOrNull(form.get("position[old_line]")),
          new_line: numberOrNull(form.get("position[new_line]")),
        }
        : null;
      notes.push({
        ...DIFF_NOTE,
        id: 6,
        body: form.get("body"),
        type: position === null ? "DiscussionNote" : "DiffNote",
        position,
      });
      return Response.json({ id: THREAD_ID, notes: [...notes] });
    }
    if (last.method === "POST" && last.pathname.endsWith("/notes")) {
      const form = new URLSearchParams(last.body);
      const reply = {
        ...DIFF_NOTE,
        id: 8,
        body: form.get("body"),
        position: (notes[0] as { position: unknown }).position,
      };
      notes.push(reply);
      return Response.json(reply);
    }
    if (last.pathname.endsWith("/discussions")) {
      return Response.json([{ id: THREAD_ID, notes: [...notes] }]);
    }
    if (last.pathname.endsWith("/changes")) return Response.json(CHANGES);
    return Response.json(MR_BODY);
  });
  try {
    const io = ioTo(recording.baseUrl);
    await runComment(
      {
        target: "src/module.txt:8",
        mr: REF,
        message: "замечание к строке",
        "body-file": undefined,
        old: false,
      },
      io,
      { runGit: noGit },
    );
    await runReply(
      {
        discussion: "a1b2c3d4",
        mr: REF,
        message: "ответ в тред",
        "body-file": undefined,
      },
      io,
      { runGit: noGit },
    );

    const thread = await runShow(
      { discussion: "a1b2c3d4", mr: REF, json: true },
      io,
      { runGit: noGit },
    );
    assertEquals(renderShow(thread, true), await golden("show-thread.json"));
  } finally {
    await recording.stop();
  }
});

/** Число из form-значения; ключа нет — null (как отдаёт GitLab). */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

Deno.test("comment: строка вне диффа — отказ до POST, эталон канала", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const args = {
      target: "src/module.txt:999",
      mr: REF,
      message: "замечание",
      "body-file": undefined,
      old: false,
    };

    await t.step(
      "текст отказа называет диапазон и подсказывает --old",
      async () => {
        const err = await assertRejects(
          () => runComment(args, io, { runGit: noGit }),
          DomainError,
        );
        assertEquals(
          `${formatCommandError("mr comment", err)}\n`,
          await golden("err-line-outside-diff.stderr"),
        );
      },
    );

    await t.step("POST не выполнялся вовсе", () => {
      assertEquals(stand.seen.some((r) => r.method === "POST"), false);
    });

    await t.step("файл не изменён в MR — перечень изменённых", async () => {
      await assertRejects(
        () =>
          runComment({ ...args, target: "src/нет.txt:5" }, io, {
            runGit: noGit,
          }),
        DomainError,
        "файл 'src/нет.txt' не изменён в этом MR; изменённые: src/module.txt",
      );
    });

    await t.step("форма FILE:LINE проверяется до сети", async () => {
      const quiet = startFakeGitlab(() => {
        throw new Error("сети быть не должно");
      });
      try {
        for (
          const [target, text] of [
            ["src/a.js", "ожидается FILE:LINE, получено 'src/a.js'"],
            ["src/a.js:0", "LINE — положительное число"],
            ["src/a.js:x", "LINE — положительное число"],
          ]
        ) {
          await assertRejects(
            () =>
              runComment({ ...args, target }, ioTo(quiet.baseUrl), {
                runGit: noGit,
              }),
            UsageError,
            text,
          );
        }
        assertEquals(quiet.seen.length, 0);
      } finally {
        await quiet.stop();
      }
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("comment --old: позиция несёт только old_line", async () => {
  const stand = standWith();
  try {
    await runComment(
      {
        target: "src/module.txt:7",
        mr: REF,
        message: "к удалённой строке",
        "body-file": undefined,
        old: true,
      },
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    const form = new URLSearchParams(
      stand.seen.find((r) => r.method === "POST")!.body,
    );
    // Removed-строки на new-стороне не существует: её номер туда не идёт.
    assertEquals(form.get("position[old_line]"), "7");
    assertEquals(form.has("position[new_line]"), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("note и reply: вывод — эталоны канала", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);

    await t.step("note", async () => {
      const result = await runNote(
        {
          mr: REF,
          message: "общий комментарий",
          "body-file": undefined,
        },
        io,
        { runGit: noGit },
      );
      // Голден снят на ноте 7; тред тот же, что у comment.
      assertEquals(
        renderNote({ ...result, note_id: 7, url: `${WEB_URL}#note_7` }),
        await golden("note-created.stdout"),
      );
    });

    await t.step("reply", async () => {
      const result = await runReply(
        {
          discussion: "a1b2c3d4",
          mr: REF,
          message: "ответ в тред",
          "body-file": undefined,
        },
        io,
        { runGit: noGit },
      );
      assertEquals(renderReply(result), await golden("reply-created.stdout"));
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("тело уходит дословно, из -m и из stdin", async (t) => {
  const stand = standWith();
  try {
    await t.step("-m: ни trim, ни дописывания", async () => {
      await runNote(
        { mr: REF, message: "текст\n", "body-file": undefined },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      const post = stand.seen.find((r) => r.method === "POST")!;
      assertEquals(new URLSearchParams(post.body).get("body"), "текст\n");
    });

    await t.step("-F -: весь stdin как есть", async () => {
      const io = ioTo(stand.baseUrl, {
        readStdin: () =>
          Promise.resolve(new TextEncoder().encode("из stdin\nвторая\n")),
      });
      await runNote({ mr: REF, message: undefined, "body-file": "-" }, io, {
        runGit: noGit,
      });
      const posts = stand.seen.filter((r) => r.method === "POST");
      assertEquals(
        new URLSearchParams(posts[posts.length - 1].body).get("body"),
        "из stdin\nвторая\n",
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("источник тела: оба флага и ни одного — отказ до сети", async (t) => {
  const quiet = startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    const io = ioTo(quiet.baseUrl);

    await t.step("оба сразу", async () => {
      await assertRejects(
        () =>
          runNote({ mr: REF, message: "текст", "body-file": "файл" }, io, {
            runGit: noGit,
          }),
        UsageError,
        "нужно ровно одно из -m/--message и -F/--body-file",
      );
    });

    await t.step("ни одного", async () => {
      await assertRejects(
        () =>
          runNote({ mr: REF, message: undefined, "body-file": undefined }, io, {
            runGit: noGit,
          }),
        UsageError,
        "нужно ровно одно из -m/--message и -F/--body-file",
      );
    });

    await t.step("пустое тело", async () => {
      await assertRejects(
        () =>
          runNote({ mr: REF, message: "   \n", "body-file": undefined }, io, {
            runGit: noGit,
          }),
        UsageError,
        "пустое тело комментария",
      );
    });

    await t.step("ни одного запроса наружу", () => {
      assertEquals(quiet.seen.length, 0);
    });
  } finally {
    await quiet.stop();
  }
});

Deno.test("resolve и unresolve: вывод, query и нерезолвабельный тред", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);

    await t.step("resolve — эталон канала", async () => {
      const result = await runResolve(
        { discussion: "a1b2c3d4", mr: REF },
        io,
        true,
        { runGit: noGit },
      );
      assertEquals(renderResolve(result), await golden("resolve.stdout"));
      const put = stand.seen.find((r) => r.method === "PUT")!;
      assertEquals(put.search, "?resolved=true");
    });

    await t.step("unresolve отличается только признаком", async () => {
      const result = await runResolve(
        { discussion: "a1b2c3d4", mr: REF },
        io,
        false,
        { runGit: noGit },
      );
      assertEquals(renderResolve(result), "discussion a1b2c3d4: unresolved\n");
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("resolve нерезолвабельного треда не шлёт PUT", async () => {
  const general = {
    id: THREAD_ID,
    notes: [{
      ...DIFF_NOTE,
      resolvable: false,
      resolved: false,
      type: null,
      position: undefined,
    }],
  };
  const stand = standWith({ discussions: [general] });
  try {
    await assertRejects(
      () =>
        runResolve(
          { discussion: "a1b2c3d4", mr: REF },
          ioTo(stand.baseUrl),
          true,
          { runGit: noGit },
        ),
      DomainError,
      "тред a1b2c3d4 нерезолвабельный (general note)",
    );
    assertEquals(stand.seen.some((r) => r.method === "PUT"), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("edit и describe: вывод — эталоны канала", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);

    await t.step("edit правит названный номер", async () => {
      const result = await runEdit(
        {
          note: 6,
          mr: REF,
          message: "новое тело",
          "body-file": undefined,
        },
        io,
        { runGit: noGit },
      );
      assertEquals(renderEdit(result), await golden("edit.stdout"));
      const put = stand.seen.find((r) => r.method === "PUT")!;
      assertEquals(
        put.pathname,
        "/api/v4/projects/group%2Frepo/merge_requests/1/notes/6",
      );
    });

    await t.step("describe заменяет описание", async () => {
      const result = await runDescribe(
        {
          mr: REF,
          message: "новое описание",
          "body-file": undefined,
        },
        io,
        { runGit: noGit },
      );
      assertEquals(renderDescribe(result), await golden("describe.stdout"));
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("edit чужой ноты: 403 — отказ, а не успех", async () => {
  const stand = startFakeGitlab((seen) =>
    seen[seen.length - 1].method === "PUT"
      ? new Response(`{"message":"403 Forbidden"}`, { status: 403 })
      : Response.json(MR_BODY)
  );
  try {
    await assertRejects(
      () =>
        runEdit(
          { note: 6, mr: REF, message: "чужое", "body-file": undefined },
          ioTo(stand.baseUrl),
          { runGit: noGit },
        ),
      DomainError,
      "403",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("delete: без TTY отказ и ни одного DELETE", async (t) => {
  const stand = standWith();
  try {
    await t.step("нет терминала — эталон канала", async () => {
      const err = await assertRejects(
        () =>
          runDelete({ note: 6, mr: REF, yes: false }, ioTo(stand.baseUrl), {
            runGit: noGit,
          }),
        DomainError,
      );
      assertEquals(
        `${formatCommandError("mr delete", err)}\n`,
        await golden("delete-no-tty.stderr"),
      );
      assertEquals(stand.seen.some((r) => r.method === "DELETE"), false);
    });

    await t.step("--yes удаляет без вопроса", async () => {
      const result = await runDelete(
        { note: 6, mr: REF, yes: true },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      assertEquals(renderDelete(result), "note 6 удалена\n");
      assertEquals(stand.seen.some((r) => r.method === "DELETE"), true);
    });

    await t.step("отказ человека в терминале — без DELETE", async () => {
      const before = stand.seen.filter((r) => r.method === "DELETE").length;
      const io = ioTo(stand.baseUrl, {
        openTerminal: () =>
          Promise.resolve({
            name: "/dev/tty",
            write: () => Promise.resolve(),
            readLine: () => Promise.resolve("n"),
            [Symbol.dispose]: () => {},
          }),
      });
      await assertRejects(
        () =>
          runDelete({ note: 6, mr: REF, yes: false }, io, { runGit: noGit }),
        DomainError,
        "отменено",
      );
      assertEquals(
        stand.seen.filter((r) => r.method === "DELETE").length,
        before,
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("create: 409 GitLab — эталон канала", async () => {
  const stand = startFakeGitlab(() =>
    new Response(
      `{"message":["Another open merge request already exists for this source branch: !1"]}`,
      { status: 409 },
    )
  );
  try {
    const err = await assertRejects(
      () =>
        runCreate(
          {
            title: "правка",
            target: "main",
            source: "feat/change",
            project: "group/repo",
            message: undefined,
            "body-file": undefined,
          },
          ioTo(stand.baseUrl),
          { runGit: noGit },
        ),
      DomainError,
    );
    assertEquals(
      `${formatCommandError("mr create", err)}\n`,
      await golden("create.stdout"),
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("create: ветка из git, detached HEAD — свой текст", async (t) => {
  await t.step("исходная ветка — текущая", async () => {
    const stand = startFakeGitlab(() => Response.json({ ...MR_BODY, iid: 7 }));
    try {
      const runGit: RunGit = () =>
        Promise.resolve({ code: 0, stdout: "feat/change\n", stderr: "" });
      const result = await runCreate(
        {
          title: "правка одной строки",
          target: "main",
          source: undefined,
          project: "group/repo",
          message: undefined,
          "body-file": undefined,
        },
        ioTo(stand.baseUrl),
        { runGit },
      );
      assertStringIncludes(
        renderCreate(result),
        "branch: feat/change → main\n",
      );
      assertEquals(
        new URLSearchParams(stand.seen[0].body).get("source_branch"),
        "feat/change",
      );
    } finally {
      await stand.stop();
    }
  });

  await t.step("detached HEAD просит --source, а не --mr", async () => {
    const stand = startFakeGitlab(() => Response.json(MR_BODY));
    try {
      const runGit: RunGit = () =>
        Promise.resolve({ code: 0, stdout: "HEAD\n", stderr: "" });
      await assertRejects(
        () =>
          runCreate(
            {
              title: "правка",
              target: "main",
              source: undefined,
              project: "group/repo",
              message: undefined,
              "body-file": undefined,
            },
            ioTo(stand.baseUrl),
            { runGit },
          ),
        DomainError,
        "detached HEAD — укажи --source",
      );
    } finally {
      await stand.stop();
    }
  });
});

Deno.test("comment: ответ без привязки — отказ, а не «создано»", async () => {
  // Тот же вызов, тот же 201 — и комментарий висит в MR без строки.
  // Промах обязан быть громким: оператор иначе уйдёт, считая, что
  // замечание встало на место.
  const stand = standWith({
    created: {
      id: THREAD_ID,
      notes: [{ ...DIFF_NOTE, type: "DiscussionNote", position: undefined }],
    },
  });
  try {
    await assertRejects(
      () =>
        runComment(
          {
            target: "src/module.txt:8",
            mr: REF,
            message: "замечание",
            "body-file": undefined,
            old: false,
          },
          ioTo(stand.baseUrl),
          { runGit: noGit },
        ),
      DomainError,
      "GitLab не привязал его к строке",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("comment на переименованный файл подтверждает новый путь", async () => {
  const renamed = {
    changes: {
      changes: [{
        old_path: "src/старый.txt",
        new_path: "src/новый.txt",
        new_file: false,
        renamed_file: true,
        deleted_file: false,
        diff: FILE_DIFF,
      }],
    },
  };
  const stand = standWith({
    ...renamed,
    created: {
      id: THREAD_ID,
      notes: [{
        ...DIFF_NOTE,
        position: {
          old_path: "src/старый.txt",
          new_path: "src/новый.txt",
          old_line: 8,
          new_line: 8,
        },
      }],
    },
  });
  try {
    const result = await runComment(
      {
        target: "src/старый.txt:8",
        mr: REF,
        message: "замечание",
        "body-file": undefined,
        old: false,
      },
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    // Оператор назвал старое имя, комментарий ушёл к новому — и
    // подтверждение обязано говорить о том, что случилось.
    assertEquals(result.path, "src/новый.txt");
    assertStringIncludes(renderComment(result), "на src/новый.txt:8\n");
  } finally {
    await stand.stop();
  }
});

Deno.test("comment: перечень изменённых включает оба имени переименованного", async () => {
  const renamed = {
    changes: {
      changes: [{
        old_path: "src/старый.txt",
        new_path: "src/новый.txt",
        new_file: false,
        renamed_file: true,
        deleted_file: false,
        diff: FILE_DIFF,
      }],
    },
  };
  const stand = standWith(renamed);
  try {
    await assertRejects(
      () =>
        runComment(
          {
            target: "src/нет.txt:8",
            mr: REF,
            message: "замечание",
            "body-file": undefined,
            old: false,
          },
          ioTo(stand.baseUrl),
          { runGit: noGit },
        ),
      DomainError,
      "изменённые: src/новый.txt, src/старый.txt",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("ответ без номера заметки — отказ у reply и у edit", async (t) => {
  const nameless = startFakeGitlab((seen) => {
    const last = seen[seen.length - 1];
    if (last.method === "POST" && last.pathname.endsWith("/notes")) {
      return Response.json({ ok: true });
    }
    if (last.method === "PUT" && last.pathname.includes("/notes/")) {
      return Response.json({ ok: true });
    }
    if (last.pathname.endsWith("/discussions")) {
      return Response.json([{ id: THREAD_ID, notes: [DIFF_NOTE] }]);
    }
    return Response.json(MR_BODY);
  });
  try {
    const io = ioTo(nameless.baseUrl);

    await t.step("reply: ссылка #note_0 вела бы в никуда", async () => {
      await assertRejects(
        () =>
          runReply(
            {
              discussion: "a1b2c3d4",
              mr: REF,
              message: "ответ",
              "body-file": undefined,
            },
            io,
            { runGit: noGit },
          ),
        DomainError,
        "GitLab не сообщил номер созданной заметки",
      );
    });

    await t.step(
      "edit: номер из ввода не подставляется вместо ответа",
      async () => {
        await assertRejects(
          () =>
            runEdit(
              {
                note: 6,
                mr: REF,
                message: "новое",
                "body-file": undefined,
              },
              io,
              { runGit: noGit },
            ),
          DomainError,
          "GitLab не сообщил номер изменённой заметки",
        );
      },
    );
  } finally {
    await nameless.stop();
  }
});
