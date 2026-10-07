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

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { type FakeGitlab, startFakeGitlab } from "../gitlab/testing.ts";
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
  return await readFile(
    new URL(`./testdata/mr-read/${name}`, import.meta.url),
    "utf8",
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

// Оба треда голдена указывают на один файл: канал обезличен
// (`docs/specs/fixtures/mr-read/comments.json`).
const INLINE_PATH = "src/module/file1.ts";
const SECOND_PATH = "src/module/file1.ts";

/** Треды ровно в форме голдена `comments.json`. */
const DISCUSSIONS = [
  {
    id: "953d395bb1c317b7317d46193627708c31882800",
    notes: [
      {
        id: 42175,
        body: "текст комментария",
        author: { name: "Имя Фамилия", username: "reviewer" },
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
      },
    ],
  },
  {
    id: "d7f534bcb52ae6545ba7b0eab6f5378863acbe88",
    notes: [
      {
        id: 42176,
        body: "текст комментария",
        author: { name: "Имя Фамилия", username: "reviewer" },
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
      },
    ],
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

describe("view: JSON — эталон канала, текстовая форма — четыре строки", () => {
  let stand: FakeGitlab;
  let mr: Awaited<ReturnType<typeof runView>>;

  beforeAll(async () => {
    stand = await standWith();
    const io = ioTo(stand.baseUrl);
    mr = await runView({ mr: REF, json: true }, io, { runGit: noGit });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("--json побайтно равен голдену", async () => {
    expect(renderView(mr, true)).toStrictEqual(await golden("view.json"));
  });

  it("текстом: шапка, пустая строка, описание", () => {
    expect(renderView(mr, false)).toStrictEqual(
      "MR group/repo!456 — feat(scope): краткое описание [opened]\n" +
        "author: Имя Фамилия (@user)\n" +
        "branch: feat/scope/change → main\n" +
        "url:    https://gitlab.example.test/group/repo/-/merge_requests/456\n" +
        "\nКарточка: https://tracker.example.test/1\n\nТело описания.\n",
    );
  });

  it("пустое описание — без пустой строки в хвосте", () => {
    expect(
      renderView({ ...mr, description: "" }, false).endsWith("456\n"),
    ).toBe(true);
  });
});

describe("files: JSON — эталон канала, таблица — суммы по файлам", () => {
  let stand: FakeGitlab;
  let result: Awaited<ReturnType<typeof runFiles>>;

  beforeAll(async () => {
    stand = await standWith();
    result = await runFiles({ mr: REF, json: true }, ioTo(stand.baseUrl), {
      runGit: noGit,
    });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("--json побайтно равен голдену", async () => {
    expect(renderFiles(result, true)).toStrictEqual(await golden("files.json"));
  });

  it("порядок файлов — порядок ответа API", () => {
    expect(result.files.map((f) => f.new_path)).toStrictEqual([
      "src/module/file1.ts",
      "src/module/file2.ts",
      "src/module/file3.ts",
    ]);
  });

  it("таблица: колонки и хвост-сумма", () => {
    const text = renderFiles(result, false);
    expect(text.startsWith("ST  +     -   FILE\n"), text).toBe(true);
    // Хвост равен сумме по `--json`: обе формы построены из одних
    // данных (инвариант спеки).
    expect(text).toContain("(3 files, +288 / -5)\n");
    expect(text).toContain("A   +159  -0  src/module/file1.ts\n");
  });
});

describe("diff: блоки, пометки статуса и фильтр по подстроке", () => {
  let stand: FakeGitlab;
  let io: CommandIo;
  let all: Awaited<ReturnType<typeof runDiff>>;

  beforeAll(async () => {
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
    stand = await standWith(renamed);
    io = ioTo(stand.baseUrl);
    all = await runDiff({ mr: REF, file: undefined, json: false }, io, {
      runGit: noGit,
    });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("заголовок с пометкой и binary отдельной строкой", () => {
    expect(renderDiff(all, false)).toStrictEqual(
      "diff --git a/src/old.ts b/src/new.ts  [renamed]\n" +
        "@@ -1,1 +1,1 @@\n-раз\n+один\n\n" +
        "diff --git a/assets/logo.png b/assets/logo.png  [new file]\n" +
        "(binary / без текстового диффа)\n",
    );
  });

  it("--file находит переименованный по старому имени", async () => {
    const filtered = await runDiff(
      { mr: REF, file: "old.ts", json: false },
      io,
      {
        runGit: noGit,
      },
    );
    expect(filtered.files.map((f) => f.new_path)).toStrictEqual(["src/new.ts"]);
  });

  it("нет совпадений — отказ, эталон канала", async () => {
    const err = await rejected(
      () =>
        runDiff({ mr: REF, file: "нет-такого-файла", json: false }, io, {
          runGit: noGit,
        }),
      DomainError,
    );
    expect(`${formatCommandError("mr diff", err)}\n`).toStrictEqual(
      await golden("err-diff-no-match.stderr"),
    );
  });
});

it("diff: MR без изменённых файлов — не отказ", async () => {
  const stand = await standWith({ changes: { changes: [] } });
  try {
    const result = await runDiff(
      { mr: REF, file: undefined, json: false },
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    expect(renderDiff(result, false)).toBe("(MR без изменённых файлов)\n");
  } finally {
    await stand.stop();
  }
});

describe("comments: JSON — эталон канала, таблица и markdown", () => {
  let stand: FakeGitlab;
  let io: CommandIo;

  const args = {
    mr: REF,
    unresolved: false,
    file: undefined,
    author: undefined,
    json: true,
    md: false,
  };

  let result: Awaited<ReturnType<typeof runComments>>;

  beforeAll(async () => {
    stand = await standWith();
    io = ioTo(stand.baseUrl);
    result = await runComments(args, io, { runGit: noGit });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("--json побайтно равен голдену", async () => {
    expect(renderComments(result, { json: true, md: false })).toStrictEqual(
      await golden("comments.json"),
    );
  });

  it("таблица: заголовок MR, колонки и хвост", () => {
    const text = renderComments(result, { json: false, md: false });
    expect(text).toContain(
      "MR group/repo!456 — feat(scope): краткое описание [opened]\n",
    );
    expect(text).toContain("DISC      RES  LOCATION");
    expect(text).toContain("953d395b  ·    " + `${INLINE_PATH}:25`);
    expect(text).toContain("(2 discussions, 2 unresolved)\n");
  });

  it("markdown: заголовок треда, ноты и разделитель", () => {
    const text = renderComments(result, { json: false, md: true });
    expect(text).toContain(
      "# MR group/repo!456 — feat(scope): краткое описание [opened]\n",
    );
    expect(text).toContain(`## 953d395b · ${INLINE_PATH}:25 · open\n`);
    expect(text).toContain(
      "**Имя Фамилия** (@reviewer) · note 42175 · 2026-08-27 17:00\n",
    );
    expect(text).toContain("\n---\n");
  });

  it("--json вместе с --md — ошибка ввода до сети", async () => {
    await rejected(
      () => runComments({ ...args, md: true }, io, { runGit: noGit }),
      UsageError,
      "only one of --json / --md can be set",
    );
  });
});

describe("comments: общий тред отличается от инлайнового только позицией", () => {
  let stand: FakeGitlab;
  let io: CommandIo;

  const args = {
    mr: REF,
    unresolved: false,
    file: undefined,
    author: undefined,
    json: false,
    md: false,
  };

  let result: Awaited<ReturnType<typeof runComments>>;

  beforeAll(async () => {
    const general = {
      id: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      notes: [
        {
          id: 1,
          body: "общий комментарий\nвторая строка",
          author: { name: "Имя", username: "user" },
          created_at: "2026-08-27T10:00:00.000Z",
          updated_at: "2026-08-27T10:00:00.000Z",
          system: false,
          resolvable: false,
          resolved: false,
          type: null,
        },
      ],
    };
    stand = await standWith({ discussions: [general, ...DISCUSSIONS] });
    io = ioTo(stand.baseUrl);
    result = await runComments(args, io, { runGit: noGit });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("location общего треда — null, инлайнового — путь:строка", () => {
    expect(result.threads[0].location).toStrictEqual(null);
    expect(result.threads[1].location).toStrictEqual(`${INLINE_PATH}:25`);
  });

  it("в markdown общий тред помечен general и note", () => {
    const text = renderComments(result, { json: false, md: true });
    expect(text).toContain("## aaaa1111 · general · note\n");
  });

  it("--unresolved отбрасывает общий тред", async () => {
    const only = await runComments({ ...args, unresolved: true }, io, {
      runGit: noGit,
    });
    expect(only.threads.map((t) => t.id.slice(0, 8))).toStrictEqual([
      "953d395b",
      "d7f534bc",
    ]);
  });

  it("--file отбрасывает тред без позиции", async () => {
    // Оба инлайновых треда голдена лежат на одном файле, общий — без
    // позиции: под файловый фильтр он не подходит вовсе (спека).
    const byFile = await runComments({ ...args, file: "file1.ts" }, io, {
      runGit: noGit,
    });
    expect(byFile.threads.map((t) => t.id.slice(0, 8))).toStrictEqual([
      "953d395b",
      "d7f534bc",
    ]);
  });

  it("--file находит тред по старому пути позиции", async () => {
    // Позиция переименованного файла несёт оба пути; оператор ищет по
    // тому имени, которое помнит.
    const renamedThread = {
      id: "cccc3333cccc3333cccc3333cccc3333cccc3333",
      notes: [
        {
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
        },
      ],
    };
    const renamedStand = await standWith({ discussions: [renamedThread] });
    try {
      const found = await runComments(
        { ...args, file: "старый" },
        ioTo(renamedStand.baseUrl),
        { runGit: noGit },
      );
      expect(found.threads.map((t) => t.id.slice(0, 8))).toStrictEqual([
        "cccc3333",
      ]);
    } finally {
      await renamedStand.stop();
    }
  });

  it("--author без учёта регистра, по первой ноте", async () => {
    const byAuthor = await runComments({ ...args, author: "REVIEWER" }, io, {
      runGit: noGit,
    });
    expect(byAuthor.threads.length).toBe(2);
    const none = await runComments({ ...args, author: "нет-такого" }, io, {
      runGit: noGit,
    });
    expect(none.threads.length).toBe(0);
    // Пустой результат фильтра — не отказ: заголовок и нулевой хвост.
    expect(renderComments(none, { json: false, md: false })).toContain(
      "(0 discussions, 0 unresolved)\n",
    );
  });
});

it("comments: системные ноты не видны ни в одной форме", async () => {
  const withSystem = [
    {
      id: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
      notes: [
        {
          id: 9,
          body: "changed title from **старое** to **новое**",
          author: { name: "Имя", username: "user" },
          created_at: "2026-08-27T10:00:00.000Z",
          updated_at: "2026-08-27T10:00:00.000Z",
          system: true,
          resolvable: false,
          resolved: false,
          type: null,
        },
      ],
    },
    ...DISCUSSIONS,
  ];
  const stand = await standWith({ discussions: withSystem });
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
    expect(result.threads.length).toBe(2);
    const all = [
      renderComments(result, { json: true, md: false }),
      renderComments(result, { json: false, md: true }),
      renderComments(result, { json: false, md: false }),
    ].join("");
    expect(all.includes("changed title")).toBe(false);
  } finally {
    await stand.stop();
  }
});

describe("show: тред по префиксу, полный id в заголовке", () => {
  let stand: FakeGitlab;
  let io: CommandIo;
  let thread: Awaited<ReturnType<typeof runShow>>;

  beforeAll(async () => {
    stand = await standWith();
    io = ioTo(stand.baseUrl);
    thread = await runShow({ discussion: "953d39", mr: REF, json: false }, io, {
      runGit: noGit,
    });
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("заголовок и нота", () => {
    expect(renderShow(thread, false)).toStrictEqual(
      `discussion 953d395bb1c317b7317d46193627708c31882800 · ` +
        `${INLINE_PATH}:25 · open\n\n` +
        "**Имя Фамилия** (@reviewer) · note 42175 · 2026-08-27 17:00\n" +
        "текст комментария\n",
    );
  });

  it("--json — форма элемента comments --json", async () => {
    const asJson = JSON.parse(renderShow(thread, true));
    const list = JSON.parse(await golden("comments.json"));
    expect(asJson).toStrictEqual(list[0]);
  });

  it("короткий и ненайденный селектор — exit 1", async () => {
    // Неоднозначный префикс проверен на уровне атома вместе с
    // текстом перечня (`gitlab/discussion.test.ts`).
    for (const ref of ["953d3", "ffffff"]) {
      await expect(
        runShow({ discussion: ref, mr: REF, json: false }, io, {
          runGit: noGit,
        }),
      ).rejects.toThrow(DomainError);
    }
  });
});

it("отказ GitLab: эталон канала с подсказкой по --mr", async () => {
  const stand = await startFakeGitlab(
    () => new Response(`{"message":"404 Not found"}`, { status: 404 }),
  );
  try {
    const err = await rejected(
      () =>
        runView({ mr: "group/repo!999999", json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    expect(`${formatCommandError("mr view", err)}\n`).toStrictEqual(
      await golden("err-mr-not-found.stderr"),
    );
  } finally {
    await stand.stop();
  }
});

it("401: подсказка называет ключ и путь, но не значение токена", async () => {
  const stand = await startFakeGitlab(
    () => new Response(`{"message":"401 Unauthorized"}`, { status: 401 }),
  );
  try {
    const err = await rejected(
      () =>
        runView({ mr: REF, json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    expect(err.message).toContain(
      "; проверь GLAB_TOKEN в /home/проба/.config/mpu/.env",
    );
    expect(err.message.includes(TOKEN)).toBe(false);
  } finally {
    await stand.stop();
  }
});

it("нераспознанный --mr — ошибка ввода, exit 2, до сети", async () => {
  const stand = await startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    await rejected(
      () =>
        runView({ mr: "чепуха", json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      UsageError,
      "формы: URL | 'group/repo!iid' | iid",
    );
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

describe("files: пустой MR и binary-файл — нули, а не отказ", () => {
  it("MR без изменённых файлов", async () => {
    const stand = await standWith({ changes: { changes: [] } });
    try {
      const result = await runFiles(
        { mr: REF, json: false },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      expect(renderFiles(result, false)).toBe(
        "ST  +  -  FILE\n(0 files, +0 / -0)\n",
      );
    } finally {
      await stand.stop();
    }
  });

  it("binary-файл: +0 / -0", async () => {
    const binary = {
      changes: {
        changes: [
          {
            old_path: "assets/logo.png",
            new_path: "assets/logo.png",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: "",
          },
        ],
      },
    };
    const stand = await standWith(binary);
    try {
      const result = await runFiles(
        { mr: REF, json: false },
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      expect(result.files[0].additions).toBe(0);
      expect(result.files[0].deletions).toBe(0);
      expect(renderFiles(result, false)).toContain("(1 files, +0 / -0)\n");
    } finally {
      await stand.stop();
    }
  });
});

it("ни одна подкоманда не делает пишущего запроса", async () => {
  // Первый инвариант спеки: read-семейство ходит только GET'ом, чем бы
  // ни кончился вызов.
  const stand = await standWith();
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
    expect(stand.seen.map((r) => r.method)).toStrictEqual(
      stand.seen.map(() => "GET"),
    );
    expect(stand.seen.length > 5).toBe(true);
  } finally {
    await stand.stop();
  }
});

describe("отказ состояния — код 1, отказ ввода — код 2", () => {
  // Место, где спека разошлась с рабочей версией: detached HEAD и
  // «ноль открытых MR» набраны верно, поэтому это не ошибка ввода.
  const runGit: RunGit = (args) =>
    Promise.resolve(
      args[0] === "remote"
        ? { code: 0, stdout: "git@127.0.0.1:group/repo.git", stderr: "" }
        : { code: 0, stdout: "HEAD", stderr: "" },
    );

  it("detached HEAD — DomainError", async () => {
    const stand = await standWith();
    try {
      await rejected(
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

  it("пустой --mr — UsageError, а не резолв по ветке", async () => {
    const stand = await standWith();
    try {
      await expect(
        runView({ mr: "", json: false }, ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      ).rejects.toThrow(UsageError);
    } finally {
      await stand.stop();
    }
  });
});
