/**
 * Команда `mpu glab-status` (`docs/specs/glab-status.md`): формы
 * вывода, окно, фильтр репозиториев и запрос веток.
 *
 * Живого GitLab нет: стенд отвечает синтетическими телами. Побайтно
 * сверяется только json — таблица рисуется по ширине терминала, у неё
 * проверяются состав и порядок колонок, шапка и хвост.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { DomainError, UsageError } from "../command/mod.ts";
import { type FakeGitlab, startFakeGitlab } from "../gitlab/testing.ts";
import type { RunGit } from "../gitlab/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  renderGlabStatus,
  runGlabStatus,
  type StatusIo,
} from "./cmd_glab_status.ts";
import { parseRepos, PIPELINE_BRANCHES } from "./rows.ts";
import { TABLE_HEADER, textWidth } from "./render.ts";

const TOKEN = "glpat-proba-Q3z8Nw";
const MR_URL = "https://gitlab.example.test/group/repo/-/merge_requests/456";

const noGit: RunGit = () => {
  throw new Error("git must not be run");
};

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/glab-status/${name}`, import.meta.url),
    "utf8",
  );
}

function ioTo(baseUrl: string, env: Record<string, string> = {}): StatusIo {
  return makeFakeIo({
    cwd: () => "/repo",
    env: (name: string) => ({ HOME: "/дом", ...env })[name],
    // Служебные строки по умолчанию глотаются: тест, которому важна
    // печать, объявляет свой приёмник сам.
    progress: () => {},
    stdoutIsTerminal: () => false,
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
      set: () => Promise.reject(new Error("не ожидается")),
      values: () => ({}),
    },
  }) as StatusIo;
}

/** Несмерженный MR: ровно тот, с которого снят голден. */
const OPEN_MR = {
  iid: 456,
  title: "feat(scope): краткое описание",
  state: "opened",
  source_branch: "feat/scope/change",
  target_branch: "main",
  web_url: MR_URL,
  author: { name: "Имя", username: "user" },
  project_id: 1001,
  sha: "9ed053dea34858fe964ab55d8607eb4b1d0b62ac",
};

/** Смерженный MR: у него спрашиваются ветки landing-коммита. */
const MERGED_MR = {
  ...OPEN_MR,
  iid: 457,
  state: "merged",
  merge_commit_sha: "abcdef0123456789",
};

const args = (overrides: Record<string, unknown> = {}) =>
  ({
    mr: [],
    since: undefined,
    repos: [],
    branches: false,
    json: false,
    ...overrides,
  }) as Parameters<typeof runGlabStatus>[0];

it("режим адреса: json — эталон канала", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"], json: true }),
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    expect(renderGlabStatus(result, args({ json: true }))).toStrictEqual(
      await golden("single-mr.json"),
    );
    // Несмерженный MR: ветки не спрашивались вовсе — один вызов.
    expect(stand.seen.length).toBe(1);
    expect(stand.seen[0].pathname.endsWith("/merge_requests/456")).toBe(true);
  } finally {
    await stand.stop();
  }
});

it("режим адреса: шапка, колонки и подвал", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    const text = renderGlabStatus(result, args());
    const lines = text.split("\n");
    // Шапка — первая строка, до таблицы.
    expect(lines[0]).toBe("group/repo!456 · opened · feat/scope/change → main");
    // Состав и порядок колонок: по ним оператор читает, докуда доехал
    // MR, и перестановка сместила бы смысл каждой галочки.
    expect(lines[2].split(/\s+/).filter((cell) => cell !== "")).toStrictEqual([
      ...TABLE_HEADER,
    ]);
    // Ветки не спрашивались — галочек нет и в подвале объяснение.
    expect(text).toContain("прочие ветки: (MR не смержен)\n");
  } finally {
    await stand.stop();
  }
});

describe("landed заполняется только у смерженного MR", () => {
  it("несмерженный: ветки не спрашиваются", async () => {
    const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!456"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      expect(result.rows[0].landed).toStrictEqual([]);
      // `null`, а не `[]`: данных о ветках нет вовсе, и в подвале это
      // читается иначе, чем «ветки есть, но пусто».
      expect(result.rows[0].other_branches).toStrictEqual(null);
      expect(stand.seen.some((r) => r.pathname.includes("/refs"))).toBe(false);
    } finally {
      await stand.stop();
    }
  });

  it("смерженный: ветки в порядке колонок", async () => {
    const stand = await startFakeGitlab((seen) =>
      seen[seen.length - 1].pathname.includes("/refs")
        ? // Ответ нарочно в обратном порядке: колонки не должны от него
          // зависеть.
          Response.json([
            { type: "branch", name: "prod" },
            { type: "branch", name: "feat/scope/change" },
            { type: "branch", name: "trunk" },
            { type: "branch", name: "хотфикс" },
          ])
        : Response.json(MERGED_MR),
    );
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      expect(result.rows[0].landed).toStrictEqual(["trunk", "prod"]);
      // Source-ветка самого MR в «прочие» не идёт: она есть у любого
      // MR и о продвижении не говорит.
      expect(result.rows[0].other_branches).toStrictEqual(["хотфикс"]);
      const refs = stand.seen.find((r) => r.pathname.includes("/refs"));
      expect(refs?.pathname.includes("/projects/1001/")).toBe(true);
      expect(refs?.search ?? "").toContain("type=branch");
    } finally {
      await stand.stop();
    }
  });
});

it("голый iid берёт проект из git remote", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const runGit: RunGit = () =>
      Promise.resolve({
        code: 0,
        stdout: "git@127.0.0.1:group/repo.git\n",
        stderr: "",
      });
    const result = await runGlabStatus(
      args({ mr: ["456"] }),
      ioTo(stand.baseUrl),
      { runGit },
    );
    expect(result.rows[0].project).toBe("group/repo");
    expect(stand.seen[0].pathname).toBe(
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
  } finally {
    await stand.stop();
  }
});

it("голый iid без git: отказ с подсказкой про формы адреса", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const err = await rejected(
      () =>
        runGlabStatus(args({ mr: ["456"] }), ioTo(stand.baseUrl), {
          runGit: () => Promise.resolve(null),
        }),
      // Разбор адреса идёт до сети — значит ошибка ввода, код 2.
      UsageError,
    );
    expect(err.message).toContain("MR '456': git не найден в PATH");
    // Флага `--mr` у команды нет — подсказка называет позиционные формы.
    expect(err.message).toContain("укажи MR как 'group/repo!iid'");
  } finally {
    await stand.stop();
  }
});

describe("мои MR: окно уходит в запрос и фильтрует выдачу", () => {
  let stand: FakeGitlab;

  beforeAll(async () => {
    const mine = [
      { ...OPEN_MR, iid: 1, web_url: MR_URL.replace("456", "1") },
      {
        ...OPEN_MR,
        iid: 2,
        state: "closed",
        web_url: MR_URL.replace("456", "2"),
      },
      {
        ...OPEN_MR,
        iid: 3,
        web_url: "https://gitlab.example.test/wb/sw-front/-/merge_requests/3",
      },
    ];
    stand = await startFakeGitlab(() => Response.json(mine));
  });

  afterAll(async () => {
    await stand.stop();
  });

  it("окно по умолчанию — неделя", async () => {
    await runGlabStatus(args(), ioTo(stand.baseUrl), {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
    });
    const search = stand.seen[0].search;
    // 7 дней назад от заданного «сейчас».
    // 7 суток назад от заданного «сейчас», в форме, которую ждёт
    // GitLab (значение уезжает URL-кодированным).
    expect(search).toContain("updated_after=2027-01-08T08%3A00%3A00Z");
    expect(search).toContain("scope=created_by_me");
  });

  it("--since сдвигает окно", async () => {
    await runGlabStatus(args({ since: "2d" }), ioTo(stand.baseUrl), {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
    });
    expect(stand.seen[1].search).toContain(
      "updated_after=2027-01-13T08%3A00%3A00Z",
    );
  });

  it("closed отсеян, чужой репозиторий отсеян", async () => {
    const result = await runGlabStatus(
      args({ repos: ["wb/sw-front"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, nowSeconds: 1_800_000_000 },
    );
    // Остался только MR из выбранного репозитория и не closed.
    expect(result.rows.map((row) => row.iid)).toStrictEqual([3]);
    expect(result.rows[0].repo).toBe("sw-front");
  });
});

it("пустой результат — строка-объяснение, не пустая таблица", async () => {
  const stand = await startFakeGitlab(() => Response.json([]));
  try {
    const lines: string[] = [];
    const io = {
      ...ioTo(stand.baseUrl),
      progress: (line: string) => void lines.push(line),
    };
    const result = await runGlabStatus(args(), io, {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
      columns: null,
    });
    expect(result.rows).toStrictEqual([]);
    // Молчание не отличить от «команда что-то проглотила»: строка
    // говорит, что искали и не нашли. Идёт она в stderr — stdout
    // остаётся пустым, чтобы конвейер не получил мусора.
    expect(lines).toStrictEqual([
      "(нет моих MR за интервал в выбранных репозиториях)",
    ]);
    expect(renderGlabStatus(result, args())).toBe("");

    // С `--json` объяснения нет: пустой массив сам по себе однозначен.
    const jsonLines: string[] = [];
    const jsonIo = {
      ...ioTo(stand.baseUrl),
      progress: (line: string) => void jsonLines.push(line),
    };
    const asJson = await runGlabStatus(args({ json: true }), jsonIo, {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
      columns: null,
    });
    expect(jsonLines).toStrictEqual([]);
    expect(renderGlabStatus(asJson, args({ json: true }))).toBe("[]\n");
  } finally {
    await stand.stop();
  }
});

describe("конфликты режимов отбиваются до сети", () => {
  let quiet: FakeGitlab;
  let io: StatusIo;
  beforeAll(async () => {
    quiet = await startFakeGitlab(() => {
      throw new Error("сети быть не должно");
    });
    io = ioTo(quiet.baseUrl);
  });
  // После всех случаев: ни один не дошёл до сети.
  afterAll(async () => {
    try {
      expect(quiet.seen.length).toBe(0);
    } finally {
      await quiet.stop();
    }
  });
  for (const [name, call, text] of [
    [
      "--since с адресом",
      args({ mr: ["group/repo!1"], since: "2d" }),
      "since:",
    ],
    [
      "--repos с адресом",
      args({ mr: ["group/repo!1"], repos: ["wb/x"] }),
      "repo:",
    ],
    ["--branches без адреса", args({ branches: true }), "branches применяется"],
  ] as const) {
    it(name, async () => {
      const err = await rejected(
        () => runGlabStatus(call, io, { runGit: noGit }),
        // Взаимоисключающие флаги разбираются до сети: код 2.
        UsageError,
        text,
      );
      expect(typeof err.hint).toBe("string");
    });
  }
});

it("токен не появляется ни в выводе, ни в отказе", async () => {
  const stand = await startFakeGitlab(
    () => new Response(`{"message":"401 Unauthorized"}`, { status: 401 }),
  );
  try {
    const err = await rejected(
      () =>
        runGlabStatus(args({ mr: ["group/repo!456"] }), ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    expect(err.message.includes(TOKEN)).toBe(false);
    expect(err.message).toContain("проверь GLAB_TOKEN в");
  } finally {
    await stand.stop();
  }
});

it("--since не разбирается — отказ ввода до сети", async () => {
  const quiet = await startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    // Неверный `--since` разбирается до сети — значит ошибка ввода
    // (код 2), правило общее с `mpu mr`.
    await rejected(
      () =>
        runGlabStatus(args({ since: "позавчера" }), ioTo(quiet.baseUrl), {
          runGit: noGit,
        }),
      UsageError,
      "--since: ожидается <число>{s|m|h|d} или unix-ts, получено 'позавчера'",
    );
  } finally {
    await quiet.stop();
  }
});

it("повтор одного MR разными формами схлопывается", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    // URL строится от адреса стенда: проверка хоста в атоме отбивает
    // ссылку на чужой инстанс, и это правильно — здесь проверяется
    // схлопывание повторов, а не она.
    const sameMr = `${stand.baseUrl}/group/repo/-/merge_requests/456`;
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456", sameMr] }),
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    expect(result.rows.length).toBe(1);
    expect(stand.seen.length).toBe(1);
  } finally {
    await stand.stop();
  }
});

it("колонок веток всегда шесть, в объявленном порядке", () => {
  expect(PIPELINE_BRANCHES).toStrictEqual([
    "trunk",
    "main",
    "dev",
    "qa",
    "predprod",
    "prod",
  ]);
  expect(TABLE_HEADER).toStrictEqual([
    "repo",
    "id",
    "title",
    ...PIPELINE_BRANCHES,
  ]);
});

it("узкий терминал: заголовок усечён, колонки веток на месте", async () => {
  const stand = await startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, columns: 60 },
    );
    const text = renderGlabStatus(result, args());
    // Колонки веток не скрываются никогда: без них таблица теряет
    // смысл, а без длинного заголовка — нет.
    const header = text
      .split("\n")[2]
      .split(/\s+/)
      .filter((c) => c !== "");
    expect(header).toStrictEqual([...TABLE_HEADER]);
    // Полный заголовок в выводе не встречается — он усечён.
    expect(text.includes(OPEN_MR.title)).toBe(false);
    expect(text).toContain("…");
  } finally {
    await stand.stop();
  }
});

it("галочка считается за две ячейки — колонки не разъезжаются", async () => {
  const stand = await startFakeGitlab((seen) =>
    seen[seen.length - 1].pathname.includes("/refs")
      ? Response.json([
          { type: "branch", name: "trunk" },
          { type: "branch", name: "prod" },
        ])
      : Response.json(MERGED_MR),
  );
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!457"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, columns: null },
    );
    const lines = renderGlabStatus(result, args()).split("\n");
    const header = lines[2];
    const row = lines[3];
    // Позиция колонки `prod` в шапке и её галочки в строке совпадают:
    // счёт по длине строки сдвинул бы всё правее первой галочки.
    // `lastIndexOf`, потому что `prod` есть и внутри `predprod`.
    const prodAt = textWidth(header.slice(0, header.lastIndexOf("prod")));
    const marks = [...row.matchAll(/✅/g)].map((m) =>
      textWidth(row.slice(0, m.index)),
    );
    expect(marks.includes(prodAt), `${header}\n${row}`).toBe(true);
  } finally {
    await stand.stop();
  }
});

it("404 от refs — «нет данных», а не пустой список веток", async () => {
  const stand = await startFakeGitlab((seen) =>
    seen[seen.length - 1].pathname.includes("/refs")
      ? // Коммита на хосте нет — например, после переписывания истории.
        new Response(`{"message":"404 Commit Not Found"}`, { status: 404 })
      : Response.json(MERGED_MR),
  );
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!457"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, columns: null },
    );
    // Отклонение `fix` спеки: `[]` означало бы «ветки спросили, их
    // нет», и подвал соврал бы «(нет)» вместо «(нет данных)».
    expect(result.rows[0].other_branches).toStrictEqual(null);
    expect(renderGlabStatus(result, args())).toContain(
      "прочие ветки: (нет данных)\n",
    );
  } finally {
    await stand.stop();
  }
});

describe("подвал: (нет), полный список и форма на несколько MR", () => {
  const branchesFor =
    (names: readonly string[]) => (seen: readonly { pathname: string }[]) =>
      seen[seen.length - 1].pathname.includes("/refs")
        ? Response.json(names.map((name) => ({ type: "branch", name })))
        : Response.json(MERGED_MR);

  it("веток вне пайплайна нет — (нет)", async () => {
    const stand = await startFakeGitlab(branchesFor(["trunk"]));
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit, columns: null },
      );
      expect(result.rows[0].other_branches).toStrictEqual([]);
      expect(renderGlabStatus(result, args())).toContain(
        "прочие ветки: (нет)\n",
      );
    } finally {
      await stand.stop();
    }
  });

  it("без --branches — счёт и подсказка, с ним — список", async () => {
    const stand = await startFakeGitlab(
      branchesFor(["trunk", "хотфикс", "релиз"]),
    );
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit, columns: null },
      );
      expect(renderGlabStatus(result, args())).toContain(
        "прочие ветки: 2 (показать: branches)\n",
      );
      expect(renderGlabStatus(result, args({ branches: true }))).toContain(
        "прочие ветки: релиз, хотфикс\n",
      );
    } finally {
      await stand.stop();
    }
  });

  it("несколько MR — строка на каждый с отступом", async () => {
    const stand = await startFakeGitlab((seen) => {
      const last = seen[seen.length - 1];
      if (last.pathname.includes("/refs")) return Response.json([]);
      const iid = Number(last.pathname.split("/").pop());
      return Response.json({ ...MERGED_MR, iid });
    });
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457", "group/repo!458"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit, columns: null },
      );
      const text = renderGlabStatus(result, args());
      expect(text).toContain("прочие ветки:\n");
      expect(text).toContain("  group/repo!457: (нет)\n");
      expect(text).toContain("  group/repo!458: (нет)\n");
    } finally {
      await stand.stop();
    }
  });
});

it("мои MR: порядок строк (repo, iid) и отсев без project", async () => {
  const url = (project: string, iid: number) =>
    `https://gitlab.example.test/${project}/-/merge_requests/${iid}`;
  const mine = [
    { ...OPEN_MR, iid: 9, web_url: url("wb/sw-back", 9) },
    { ...OPEN_MR, iid: 2, web_url: url("wb/sl-front", 2) },
    { ...OPEN_MR, iid: 1, web_url: url("wb/sw-back", 1) },
    // Без маркера `/-/` project не определяется — строка отпадает.
    { ...OPEN_MR, iid: 7, web_url: "https://gitlab.example.test/wb/sw-back" },
  ];
  const stand = await startFakeGitlab(() => Response.json(mine));
  try {
    const result = await runGlabStatus(args(), ioTo(stand.baseUrl), {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
      columns: null,
    });
    expect(result.rows.map((row) => `${row.repo}!${row.iid}`)).toStrictEqual([
      "sl-front!2",
      "sw-back!1",
      "sw-back!9",
    ]);
  } finally {
    await stand.stop();
  }
});

it("--repos: префикс wb/, пустые сегменты, только запятые", () => {
  expect(parseRepos(["sw-front"])).toStrictEqual(["wb/sw-front"]);
  expect(parseRepos(["wb/sl-back, sw-back"])).toStrictEqual([
    "wb/sl-back",
    "wb/sw-back",
  ]);
  expect(parseRepos(["a", "b,c"])).toStrictEqual(["wb/a", "wb/b", "wb/c"]);
  // Только разделители — пустой фильтр: валидный вызов с пустым
  // результатом, а не ошибка.
  expect(parseRepos([" , , "])).toStrictEqual([]);
});
