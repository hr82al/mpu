/**
 * Read-подкоманды `mpu mr` (`docs/specs/mr-read.md`) на фейковом
 * GitLab: формы вывода против эталонов канала, фильтры, порядок и
 * коды выхода.
 *
 * Живого GitLab здесь нет: стенд отвечает синтетическими телами,
 * собранными так, чтобы вывод сошёлся с голденом побайтно. Счётчики
 * строк голдена `files.json` считает наш же разбор диффа, поэтому
 * дифф стенда порождается программно — вписанный руками разошёлся бы
 * с числом «+»-строк молча.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { startFakeGitlab } from "../gitlab/testing.ts";
import type { RunGit } from "../gitlab/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runComments } from "./cmd_comments.ts";
import { renderComments } from "./cmd_comments.ts";
import { renderDiff, runDiff } from "./cmd_diff.ts";
import { renderFiles, runFiles } from "./cmd_files.ts";
import { renderShow, runShow } from "./cmd_show.ts";
import { renderView, runView } from "./cmd_view.ts";

const TOKEN = "glpat-proba-Q3z8NwToken";
const REF = "group/repo!456";

/** git, который падает при первом вызове: полный селектор его не зовёт. */
const noGit: RunGit = () => {
  throw new Error("git must not be run");
};

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/mr-read/${name}`, import.meta.url),
  );
}

/** io с env-файлом, указывающим на стенд. */
function ioTo(baseUrl: string): CommandIo {
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
  });
}

/** Шапка MR ровно в форме голдена `view.json`. */
const MR_BODY = {
  iid: 456,
  title: "feat(scope): краткое описание",
  state: "opened",
  source_branch: "feat/scope/change",
  target_branch: "main",
  web_url: "https://gitlab.example.test/group/repo/-/merge_requests/456",
  author: { name: "Имя Фамилия", username: "user" },
  description: "Карточка: https://tracker.example.test/1\n\nТело описания.",
  diff_refs: {
    base_sha: "9108d6bf05a5ad5fe2dd6b0882a0384ac5e9beed",
    start_sha: "1d16b1edbd38071a020fc85f87b3fc18403b4185",
    head_sha: "9ed053dea34858fe964ab55d8607eb4b1d0b62ac",
  },
  project_id: 1001,
  sha: "9ed053dea34858fe964ab55d8607eb4b1d0b62ac",
  merge_commit_sha: null,
  squash_commit_sha: null,
};

/** Дифф с заданным числом добавленных и удалённых строк. */
function diffOf(additions: number, deletions: number): string {
  const body = [
    ...Array.from({ length: deletions }, (_, i) => `-старая ${i + 1}`),
    ...Array.from({ length: additions }, (_, i) => `+новая ${i + 1}`),
  ];
  return `@@ -1,${deletions + 1} +1,${additions + 1} @@\n${body.join("\n")}\n`;
}

/** Файлы MR ровно в форме голдена `files.json`. */
const CHANGES = [
  {
    old_path: "src/module/file1.ts",
    new_path: "src/module/file1.ts",
    new_file: true,
    renamed_file: false,
    deleted_file: false,
    diff: diffOf(159, 0),
  },
  {
    old_path: "src/module/file2.ts",
    new_path: "src/module/file2.ts",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: diffOf(66, 1),
  },
  {
    old_path: "src/module/file3.ts",
    new_path: "src/module/file3.ts",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: diffOf(63, 4),
  },
];

const INLINE_PATH = "apps/ingest/src/ozonFetch/cabinetCooldown.store.spec.ts";
const SECOND_PATH = "apps/ingest/src/ozonFetch/ozonRateGate.ts";

/** Треды ровно в форме голдена `comments.json`. */
const DISCUSSIONS = [
  {
    id: "953d395bb1c317b7317d46193627708c31882800",
    notes: [{
      id: 42175,
      body: "текст комментария",
      author: { name: "Имя Фамилия", username: "pasternake" },
      created_at: "2026-08-27T17:00:10.721Z",
      updated_at: "2026-08-27T17:00:10.721Z",
      system: false,
      resolvable: true,
      resolved: false,
      type: "DiffNote",
      position: {
        old_path: INLINE_PATH,
        new_path: INLINE_PATH,
        old_line: null,
        new_line: 25,
      },
    }],
  },
  {
    id: "d7f534bcb52ae6545ba7b0eab6f5378863acbe88",
    notes: [{
      id: 42176,
      body: "текст комментария",
      author: { name: "Имя Фамилия", username: "pasternake" },
      created_at: "2026-08-27T17:00:17.416Z",
      updated_at: "2026-08-27T17:00:17.416Z",
      system: false,
      resolvable: true,
      resolved: false,
      type: "DiffNote",
      position: {
        old_path: SECOND_PATH,
        new_path: SECOND_PATH,
        old_line: null,
        new_line: 196,
      },
    }],
  },
];

/** Стенд, отвечающий по пути запроса; ответы — синтетические тела. */
function standWith(
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof startFakeGitlab> {
  return startFakeGitlab((seen) => {
    const path = seen[seen.length - 1].pathname;
    if (path.endsWith("/changes")) {
      return Response.json(overrides.changes ?? { changes: CHANGES });
    }
    if (path.endsWith("/discussions")) {
      return Response.json(overrides.discussions ?? DISCUSSIONS);
    }
    return Response.json(overrides.mr ?? MR_BODY);
  });
}

Deno.test("view: JSON — эталон канала, текстовая форма — четыре строки", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const mr = await runView({ mr: REF, json: true }, io, { runGit: noGit });

    await t.step("--json побайтно равен голдену", async () => {
      assertEquals(renderView(mr, true), await golden("view.json"));
    });

    await t.step("текстом: шапка, пустая строка, описание", () => {
      assertEquals(
        renderView(mr, false),
        "MR group/repo!456 — feat(scope): краткое описание [opened]\n" +
          "author: Имя Фамилия (@user)\n" +
          "branch: feat/scope/change → main\n" +
          "url:    https://gitlab.example.test/group/repo/-/merge_requests/456\n" +
          "\nКарточка: https://tracker.example.test/1\n\nТело описания.\n",
      );
    });

    await t.step("пустое описание — без пустой строки в хвосте", () => {
      assertEquals(
        renderView({ ...mr, description: "" }, false).endsWith("456\n"),
        true,
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("files: JSON — эталон канала, таблица — суммы по файлам", async (t) => {
  const stand = standWith();
  try {
    const result = await runFiles(
      { mr: REF, json: true },
      ioTo(stand.baseUrl),
      {
        runGit: noGit,
      },
    );

    await t.step("--json побайтно равен голдену", async () => {
      assertEquals(renderFiles(result, true), await golden("files.json"));
    });

    await t.step("порядок файлов — порядок ответа API", () => {
      assertEquals(result.files.map((f) => f.new_path), [
        "src/module/file1.ts",
        "src/module/file2.ts",
        "src/module/file3.ts",
      ]);
    });

    await t.step("таблица: колонки и хвост-сумма", () => {
      const text = renderFiles(result, false);
      assertEquals(text.startsWith("ST  +     -   FILE\n"), true, text);
      // Хвост равен сумме по `--json`: обе формы построены из одних
      // данных (инвариант спеки).
      assertStringIncludes(text, "(3 files, +288 / -5)\n");
      assertStringIncludes(text, "A   +159  -0  src/module/file1.ts\n");
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("diff: блоки, пометки статуса и фильтр по подстроке", async (t) => {
  const renamed = {
    changes: {
      changes: [
        {
          old_path: "src/old.ts",
          new_path: "src/new.ts",
          new_file: false,
          renamed_file: true,
          deleted_file: false,
          diff: "@@ -1,1 +1,1 @@\n-раз\n+один\n",
        },
        {
          old_path: "assets/logo.png",
          new_path: "assets/logo.png",
          new_file: true,
          renamed_file: false,
          deleted_file: false,
          diff: "",
        },
      ],
    },
  };
  const stand = standWith(renamed);
  try {
    const io = ioTo(stand.baseUrl);
    const all = await runDiff({ mr: REF, file: undefined, json: false }, io, {
      runGit: noGit,
    });

    await t.step("заголовок с пометкой и binary отдельной строкой", () => {
      assertEquals(
        renderDiff(all, false),
        "diff --git a/src/old.ts b/src/new.ts  [renamed]\n" +
          "@@ -1,1 +1,1 @@\n-раз\n+один\n\n" +
          "diff --git a/assets/logo.png b/assets/logo.png  [new file]\n" +
          "(binary / без текстового диффа)\n",
      );
    });

    await t.step(
      "--file находит переименованный по старому имени",
      async () => {
        const filtered = await runDiff(
          { mr: REF, file: "old.ts", json: false },
          io,
          {
            runGit: noGit,
          },
        );
        assertEquals(filtered.files.map((f) => f.new_path), ["src/new.ts"]);
      },
    );

    await t.step("нет совпадений — отказ, эталон канала", async () => {
      const err = await assertRejects(
        () =>
          runDiff({ mr: REF, file: "нет-такого-файла", json: false }, io, {
            runGit: noGit,
          }),
        DomainError,
      );
      assertEquals(
        `${formatCommandError("mr diff", err)}\n`,
        await golden("err-diff-no-match.stderr"),
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("diff: MR без изменённых файлов — не отказ", async () => {
  const stand = standWith({ changes: { changes: [] } });
  try {
    const result = await runDiff(
      { mr: REF, file: undefined, json: false },
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    assertEquals(renderDiff(result, false), "(MR без изменённых файлов)\n");
  } finally {
    await stand.stop();
  }
});

Deno.test("comments: JSON — эталон канала, таблица и markdown", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const args = {
      mr: REF,
      unresolved: false,
      file: undefined,
      author: undefined,
      json: true,
      md: false,
    };
    const result = await runComments(args, io, { runGit: noGit });

    await t.step("--json побайтно равен голдену", async () => {
      assertEquals(
        renderComments(result, { json: true, md: false }),
        await golden("comments.json"),
      );
    });

    await t.step("таблица: заголовок MR, колонки и хвост", () => {
      const text = renderComments(result, { json: false, md: false });
      assertStringIncludes(
        text,
        "MR group/repo!456 — feat(scope): краткое описание [opened]\n",
      );
      assertStringIncludes(text, "DISC      RES  LOCATION");
      assertStringIncludes(text, "953d395b  ·    " + `${INLINE_PATH}:25`);
      assertStringIncludes(text, "(2 discussions, 2 unresolved)\n");
    });

    await t.step("markdown: заголовок треда, ноты и разделитель", () => {
      const text = renderComments(result, { json: false, md: true });
      assertStringIncludes(
        text,
        "# MR group/repo!456 — feat(scope): краткое описание [opened]\n",
      );
      assertStringIncludes(text, `## 953d395b · ${INLINE_PATH}:25 · open\n`);
      assertStringIncludes(
        text,
        "**Имя Фамилия** (@pasternake) · note 42175 · 2026-08-27 17:00\n",
      );
      assertStringIncludes(text, "\n---\n");
    });

    await t.step("--json вместе с --md — ошибка ввода до сети", async () => {
      await assertRejects(
        () => runComments({ ...args, md: true }, io, { runGit: noGit }),
        UsageError,
        "only one of --json / --md can be set",
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("comments: общий тред отличается от инлайнового только позицией", async (t) => {
  const general = {
    id: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    notes: [{
      id: 1,
      body: "общий комментарий\nвторая строка",
      author: { name: "Имя", username: "user" },
      created_at: "2026-08-27T10:00:00.000Z",
      updated_at: "2026-08-27T10:00:00.000Z",
      system: false,
      resolvable: false,
      resolved: false,
      type: null,
    }],
  };
  const stand = standWith({ discussions: [general, ...DISCUSSIONS] });
  try {
    const io = ioTo(stand.baseUrl);
    const args = {
      mr: REF,
      unresolved: false,
      file: undefined,
      author: undefined,
      json: false,
      md: false,
    };
    const result = await runComments(args, io, { runGit: noGit });

    await t.step(
      "location общего треда — null, инлайнового — путь:строка",
      () => {
        assertEquals(result.threads[0].location, null);
        assertEquals(result.threads[1].location, `${INLINE_PATH}:25`);
      },
    );

    await t.step("в markdown общий тред помечен general и note", () => {
      const text = renderComments(result, { json: false, md: true });
      assertStringIncludes(text, "## aaaa1111 · general · note\n");
    });

    await t.step("--unresolved отбрасывает общий тред", async () => {
      const only = await runComments({ ...args, unresolved: true }, io, {
        runGit: noGit,
      });
      assertEquals(only.threads.map((t) => t.id.slice(0, 8)), [
        "953d395b",
        "d7f534bc",
      ]);
    });

    await t.step("--file отбрасывает тред без позиции", async () => {
      const byFile = await runComments({ ...args, file: "ozonRateGate" }, io, {
        runGit: noGit,
      });
      assertEquals(byFile.threads.map((t) => t.id.slice(0, 8)), ["d7f534bc"]);
    });

    await t.step("--file находит тред по старому пути позиции", async () => {
      // Позиция переименованного файла несёт оба пути; оператор ищет по
      // тому имени, которое помнит.
      const renamedThread = {
        id: "cccc3333cccc3333cccc3333cccc3333cccc3333",
        notes: [{
          id: 7,
          body: "на переименованном файле",
          author: { name: "Имя", username: "user" },
          created_at: "2026-08-27T11:00:00.000Z",
          updated_at: "2026-08-27T11:00:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
          type: "DiffNote",
          position: {
            old_path: "src/старый.ts",
            new_path: "src/новый.ts",
            old_line: null,
            new_line: 3,
          },
        }],
      };
      const renamedStand = standWith({ discussions: [renamedThread] });
      try {
        const found = await runComments(
          { ...args, file: "старый" },
          ioTo(renamedStand.baseUrl),
          { runGit: noGit },
        );
        assertEquals(found.threads.map((t) => t.id.slice(0, 8)), ["cccc3333"]);
      } finally {
        await renamedStand.stop();
      }
    });

    await t.step("--author без учёта регистра, по первой ноте", async () => {
      const byAuthor = await runComments(
        { ...args, author: "PASTERNAKE" },
        io,
        {
          runGit: noGit,
        },
      );
      assertEquals(byAuthor.threads.length, 2);
      const none = await runComments({ ...args, author: "нет-такого" }, io, {
        runGit: noGit,
      });
      assertEquals(none.threads.length, 0);
      // Пустой результат фильтра — не отказ: заголовок и нулевой хвост.
      assertStringIncludes(
        renderComments(none, { json: false, md: false }),
        "(0 discussions, 0 unresolved)\n",
      );
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("comments: системные ноты не видны ни в одной форме", async () => {
  const withSystem = [
    {
      id: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
      notes: [{
        id: 9,
        body: "changed title from **старое** to **новое**",
        author: { name: "Имя", username: "user" },
        created_at: "2026-08-27T10:00:00.000Z",
        updated_at: "2026-08-27T10:00:00.000Z",
        system: true,
        resolvable: false,
        resolved: false,
        type: null,
      }],
    },
    ...DISCUSSIONS,
  ];
  const stand = standWith({ discussions: withSystem });
  try {
    const result = await runComments(
      {
        mr: REF,
        unresolved: false,
        file: undefined,
        author: undefined,
        json: false,
        md: false,
      },
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    assertEquals(result.threads.length, 2);
    const all = [
      renderComments(result, { json: true, md: false }),
      renderComments(result, { json: false, md: true }),
      renderComments(result, { json: false, md: false }),
    ].join("");
    assertEquals(all.includes("changed title"), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("show: тред по префиксу, полный id в заголовке", async (t) => {
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const thread = await runShow(
      { discussion: "953d39", mr: REF, json: false },
      io,
      { runGit: noGit },
    );

    await t.step("заголовок и нота", () => {
      assertEquals(
        renderShow(thread, false),
        `discussion 953d395bb1c317b7317d46193627708c31882800 · ` +
          `${INLINE_PATH}:25 · open\n\n` +
          "**Имя Фамилия** (@pasternake) · note 42175 · 2026-08-27 17:00\n" +
          "текст комментария\n",
      );
    });

    await t.step("--json — форма элемента comments --json", async () => {
      const asJson = JSON.parse(renderShow(thread, true));
      const list = JSON.parse(await golden("comments.json"));
      assertEquals(asJson, list[0]);
    });

    await t.step("короткий и ненайденный селектор — exit 1", async () => {
      // Неоднозначный префикс проверен на уровне атома вместе с
      // текстом перечня (`gitlab/discussion_test.ts`).
      for (const ref of ["953d3", "ffffff"]) {
        await assertRejects(
          () =>
            runShow({ discussion: ref, mr: REF, json: false }, io, {
              runGit: noGit,
            }),
          DomainError,
        );
      }
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("отказ GitLab: эталон канала с подсказкой по --mr", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"404 Not found"}`, { status: 404 })
  );
  try {
    const err = await assertRejects(
      () =>
        runView({ mr: "group/repo!999999", json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    assertEquals(
      `${formatCommandError("mr view", err)}\n`,
      await golden("err-mr-not-found.stderr"),
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("401: подсказка называет ключ и путь, но не значение токена", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"401 Unauthorized"}`, { status: 401 })
  );
  try {
    const err = await assertRejects(
      () =>
        runView({ mr: REF, json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    assertStringIncludes(
      err.message,
      "; проверь GLAB_TOKEN в /home/проба/.config/mpu/.env",
    );
    assertEquals(err.message.includes(TOKEN), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("нераспознанный --mr — ошибка ввода, exit 2, до сети", async () => {
  const stand = startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    await assertRejects(
      () =>
        runView({ mr: "чепуха", json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      UsageError,
      "формы: URL | 'group/repo!iid' | iid",
    );
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("files: пустой MR и binary-файл — нули, а не отказ", async (t) => {
  await t.step("MR без изменённых файлов", async () => {
    const stand = standWith({ changes: { changes: [] } });
    try {
      const result = await runFiles(
        { mr: REF, json: false },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      assertEquals(
        renderFiles(result, false),
        "ST  +  -  FILE\n(0 files, +0 / -0)\n",
      );
    } finally {
      await stand.stop();
    }
  });

  await t.step("binary-файл: +0 / -0", async () => {
    const binary = {
      changes: {
        changes: [{
          old_path: "assets/logo.png",
          new_path: "assets/logo.png",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
          diff: "",
        }],
      },
    };
    const stand = standWith(binary);
    try {
      const result = await runFiles(
        { mr: REF, json: false },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      assertEquals(result.files[0].additions, 0);
      assertEquals(result.files[0].deletions, 0);
      assertStringIncludes(renderFiles(result, false), "(1 files, +0 / -0)\n");
    } finally {
      await stand.stop();
    }
  });
});

Deno.test("ни одна подкоманда не делает пишущего запроса", async () => {
  // Первый инвариант спеки: read-семейство ходит только GET'ом, чем бы
  // ни кончился вызов.
  const stand = standWith();
  try {
    const io = ioTo(stand.baseUrl);
    const options = { runGit: noGit };
    await runView({ mr: REF, json: false }, io, options);
    await runFiles({ mr: REF, json: false }, io, options);
    await runDiff({ mr: REF, file: undefined, json: false }, io, options);
    await runComments(
      {
        mr: REF,
        unresolved: false,
        file: undefined,
        author: undefined,
        json: false,
        md: false,
      },
      io,
      options,
    );
    await runShow({ discussion: "953d39", mr: REF, json: false }, io, options);
    assertEquals(stand.seen.map((r) => r.method), stand.seen.map(() => "GET"));
    assertEquals(stand.seen.length > 5, true);
  } finally {
    await stand.stop();
  }
});

Deno.test("отказ состояния — код 1, отказ ввода — код 2", async (t) => {
  // Место, где спека разошлась с рабочей версией: detached HEAD и
  // «ноль открытых MR» набраны верно, поэтому это не ошибка ввода.
  const runGit: RunGit = (args) =>
    Promise.resolve(
      args[0] === "remote"
        ? { code: 0, stdout: "git@127.0.0.1:group/repo.git", stderr: "" }
        : { code: 0, stdout: "HEAD", stderr: "" },
    );

  await t.step("detached HEAD — DomainError", async () => {
    const stand = standWith();
    try {
      await assertRejects(
        () =>
          runView({ mr: undefined, json: false }, ioTo(stand.baseUrl), {
            runGit,
          }),
        DomainError,
        "detached HEAD — не определить ветку, укажи MR через --mr",
      );
    } finally {
      await stand.stop();
    }
  });

  await t.step("пустой --mr — UsageError, а не резолв по ветке", async () => {
    const stand = standWith();
    try {
      await assertRejects(
        () =>
          runView({ mr: "", json: false }, ioTo(stand.baseUrl), {
            runGit: noGit,
          }),
        UsageError,
      );
    } finally {
      await stand.stop();
    }
  });
});
