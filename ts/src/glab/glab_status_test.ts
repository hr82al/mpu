/**
 * Команда `mpu glab-status` (`docs/specs/glab-status.md`): формы
 * вывода, окно, фильтр репозиториев и запрос веток.
 *
 * Живого GitLab нет: стенд отвечает синтетическими телами. Побайтно
 * сверяется только json — таблица рисуется по ширине терминала, у неё
 * проверяются состав и порядок колонок, шапка и хвост.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { startFakeGitlab } from "../gitlab/testing.ts";
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
  return await Deno.readTextFile(
    new URL(`./testdata/glab-status/${name}`, import.meta.url),
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

Deno.test("режим адреса: json — эталон канала", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"], json: true }),
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    assertEquals(
      renderGlabStatus(result, args({ json: true })),
      await golden("single-mr.json"),
    );
    // Несмерженный MR: ветки не спрашивались вовсе — один вызов.
    assertEquals(stand.seen.length, 1);
    assertEquals(stand.seen[0].pathname.endsWith("/merge_requests/456"), true);
  } finally {
    await stand.stop();
  }
});

Deno.test("режим адреса: шапка, колонки и подвал", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit },
    );
    const text = renderGlabStatus(result, args());
    const lines = text.split("\n");
    // Шапка — первая строка, до таблицы.
    assertEquals(
      lines[0],
      "group/repo!456 · opened · feat/scope/change → main",
    );
    // Состав и порядок колонок: по ним оператор читает, докуда доехал
    // MR, и перестановка сместила бы смысл каждой галочки.
    assertEquals(lines[2].split(/\s+/).filter((cell) => cell !== ""), [
      ...TABLE_HEADER,
    ]);
    // Ветки не спрашивались — галочек нет и в подвале объяснение.
    assertStringIncludes(text, "прочие ветки: (MR не смержен)\n");
  } finally {
    await stand.stop();
  }
});

Deno.test("landed заполняется только у смерженного MR", async (t) => {
  await t.step("несмерженный: ветки не спрашиваются", async () => {
    const stand = startFakeGitlab(() => Response.json(OPEN_MR));
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!456"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      assertEquals(result.rows[0].landed, []);
      // `null`, а не `[]`: данных о ветках нет вовсе, и в подвале это
      // читается иначе, чем «ветки есть, но пусто».
      assertEquals(result.rows[0].other_branches, null);
      assertEquals(stand.seen.some((r) => r.pathname.includes("/refs")), false);
    } finally {
      await stand.stop();
    }
  });

  await t.step("смерженный: ветки в порядке колонок", async () => {
    const stand = startFakeGitlab((seen) =>
      seen[seen.length - 1].pathname.includes("/refs")
        // Ответ нарочно в обратном порядке: колонки не должны от него
        // зависеть.
        ? Response.json([
          { type: "branch", name: "prod" },
          { type: "branch", name: "feat/scope/change" },
          { type: "branch", name: "trunk" },
          { type: "branch", name: "хотфикс" },
        ])
        : Response.json(MERGED_MR)
    );
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit },
      );
      assertEquals(result.rows[0].landed, ["trunk", "prod"]);
      // Source-ветка самого MR в «прочие» не идёт: она есть у любого
      // MR и о продвижении не говорит.
      assertEquals(result.rows[0].other_branches, ["хотфикс"]);
      const refs = stand.seen.find((r) => r.pathname.includes("/refs"));
      assertEquals(refs?.pathname.includes("/projects/1001/"), true);
      assertStringIncludes(refs?.search ?? "", "type=branch");
    } finally {
      await stand.stop();
    }
  });
});

Deno.test("голый iid берёт проект из git remote", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
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
    assertEquals(result.rows[0].project, "group/repo");
    assertEquals(
      stand.seen[0].pathname,
      "/api/v4/projects/group%2Frepo/merge_requests/456",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("голый iid без git: отказ с подсказкой про формы адреса", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const err = await assertRejects(
      () =>
        runGlabStatus(args({ mr: ["456"] }), ioTo(stand.baseUrl), {
          runGit: () => Promise.resolve(null),
        }),
      DomainError,
    );
    assertStringIncludes(err.message, "MR '456': git не найден в PATH");
    // Флага `--mr` у команды нет — подсказка называет позиционные формы.
    assertStringIncludes(err.message, "укажи MR как 'group/repo!iid'");
  } finally {
    await stand.stop();
  }
});

Deno.test("мои MR: окно уходит в запрос и фильтрует выдачу", async (t) => {
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
  const stand = startFakeGitlab(() => Response.json(mine));
  try {
    await t.step("окно по умолчанию — неделя", async () => {
      await runGlabStatus(args(), ioTo(stand.baseUrl), {
        runGit: noGit,
        nowSeconds: 1_800_000_000,
      });
      const search = stand.seen[0].search;
      // 7 дней назад от заданного «сейчас».
      // 7 суток назад от заданного «сейчас», в форме, которую ждёт
      // GitLab (значение уезжает URL-кодированным).
      assertStringIncludes(search, "updated_after=2027-01-08T08%3A00%3A00Z");
      assertStringIncludes(search, "scope=created_by_me");
    });

    await t.step("--since сдвигает окно", async () => {
      await runGlabStatus(args({ since: "2d" }), ioTo(stand.baseUrl), {
        runGit: noGit,
        nowSeconds: 1_800_000_000,
      });
      assertStringIncludes(
        stand.seen[1].search,
        "updated_after=2027-01-13T08%3A00%3A00Z",
      );
    });

    await t.step("closed отсеян, чужой репозиторий отсеян", async () => {
      const result = await runGlabStatus(
        args({ repos: ["wb/sw-front"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit, nowSeconds: 1_800_000_000 },
      );
      // Остался только MR из выбранного репозитория и не closed.
      assertEquals(result.rows.map((row) => row.iid), [3]);
      assertEquals(result.rows[0].repo, "sw-front");
    });
  } finally {
    await stand.stop();
  }
});

Deno.test("пустой результат — строка-объяснение, не пустая таблица", async () => {
  const stand = startFakeGitlab(() => Response.json([]));
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
    assertEquals(result.rows, []);
    // Молчание не отличить от «команда что-то проглотила»: строка
    // говорит, что искали и не нашли. Идёт она в stderr — stdout
    // остаётся пустым, чтобы конвейер не получил мусора.
    assertEquals(lines, ["(нет моих MR за интервал в выбранных репозиториях)"]);
    assertEquals(renderGlabStatus(result, args()), "");

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
    assertEquals(jsonLines, []);
    assertEquals(renderGlabStatus(asJson, args({ json: true })), "[]\n");
  } finally {
    await stand.stop();
  }
});

Deno.test("конфликты режимов отбиваются до сети", async (t) => {
  const quiet = startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    const io = ioTo(quiet.baseUrl);
    for (
      const [name, call, text] of [
        [
          "--since с адресом",
          args({ mr: ["group/repo!1"], since: "2d" }),
          "--since",
        ],
        [
          "--repos с адресом",
          args({ mr: ["group/repo!1"], repos: ["wb/x"] }),
          "--repos",
        ],
        ["--branches без адреса", args({ branches: true }), "--branches"],
      ] as const
    ) {
      await t.step(name, async () => {
        const err = await assertRejects(
          () => runGlabStatus(call, io, { runGit: noGit }),
          DomainError,
          text,
        );
        assertEquals(typeof err.hint, "string");
      });
    }
    assertEquals(quiet.seen.length, 0);
  } finally {
    await quiet.stop();
  }
});

Deno.test("токен не появляется ни в выводе, ни в отказе", async () => {
  const stand = startFakeGitlab(() =>
    new Response(`{"message":"401 Unauthorized"}`, { status: 401 })
  );
  try {
    const err = await assertRejects(
      () =>
        runGlabStatus(args({ mr: ["group/repo!456"] }), ioTo(stand.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
    );
    assertEquals(err.message.includes(TOKEN), false);
    assertStringIncludes(err.message, "проверь GLAB_TOKEN в");
  } finally {
    await stand.stop();
  }
});

Deno.test("--since не разбирается — отказ ввода до сети", async () => {
  const quiet = startFakeGitlab(() => {
    throw new Error("сети быть не должно");
  });
  try {
    // Спека этой команды отдаёт коду 2 только разбор argv: неверный
    // `--since` — ошибка команды, то есть код 1 (у `mpu mr` решение
    // обратное, и это разные контракты).
    await assertRejects(
      () =>
        runGlabStatus(args({ since: "позавчера" }), ioTo(quiet.baseUrl), {
          runGit: noGit,
        }),
      DomainError,
      "--since: ожидается <число>{s|m|h|d} или unix-ts, получено 'позавчера'",
    );
  } finally {
    await quiet.stop();
  }
});

Deno.test("повтор одного MR разными формами схлопывается", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
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
    assertEquals(result.rows.length, 1);
    assertEquals(stand.seen.length, 1);
  } finally {
    await stand.stop();
  }
});

Deno.test("колонок веток всегда шесть, в объявленном порядке", () => {
  assertEquals(PIPELINE_BRANCHES, [
    "trunk",
    "main",
    "dev",
    "qa",
    "predprod",
    "prod",
  ]);
  assertEquals(TABLE_HEADER, ["repo", "id", "title", ...PIPELINE_BRANCHES]);
});

Deno.test("узкий терминал: заголовок усечён, колонки веток на месте", async () => {
  const stand = startFakeGitlab(() => Response.json(OPEN_MR));
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!456"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, columns: 60 },
    );
    const text = renderGlabStatus(result, args());
    // Колонки веток не скрываются никогда: без них таблица теряет
    // смысл, а без длинного заголовка — нет.
    const header = text.split("\n")[2].split(/\s+/).filter((c) => c !== "");
    assertEquals(header, [...TABLE_HEADER]);
    // Полный заголовок в выводе не встречается — он усечён.
    assertEquals(text.includes(OPEN_MR.title), false);
    assertStringIncludes(text, "…");
  } finally {
    await stand.stop();
  }
});

Deno.test("галочка считается за две ячейки — колонки не разъезжаются", async () => {
  const stand = startFakeGitlab((seen) =>
    seen[seen.length - 1].pathname.includes("/refs")
      ? Response.json([
        { type: "branch", name: "trunk" },
        { type: "branch", name: "prod" },
      ])
      : Response.json(MERGED_MR)
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
      textWidth(row.slice(0, m.index))
    );
    assertEquals(marks.includes(prodAt), true, `${header}\n${row}`);
  } finally {
    await stand.stop();
  }
});

Deno.test("404 от refs — «нет данных», а не пустой список веток", async () => {
  const stand = startFakeGitlab((seen) =>
    seen[seen.length - 1].pathname.includes("/refs")
      // Коммита на хосте нет — например, после переписывания истории.
      ? new Response(`{"message":"404 Commit Not Found"}`, { status: 404 })
      : Response.json(MERGED_MR)
  );
  try {
    const result = await runGlabStatus(
      args({ mr: ["group/repo!457"] }),
      ioTo(stand.baseUrl),
      { runGit: noGit, columns: null },
    );
    // Отклонение `fix` спеки: `[]` означало бы «ветки спросили, их
    // нет», и подвал соврал бы «(нет)» вместо «(нет данных)».
    assertEquals(result.rows[0].other_branches, null);
    assertStringIncludes(
      renderGlabStatus(result, args()),
      "прочие ветки: (нет данных)\n",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("подвал: (нет), полный список и форма на несколько MR", async (t) => {
  const branchesFor =
    (names: readonly string[]) => (seen: readonly { pathname: string }[]) =>
      seen[seen.length - 1].pathname.includes("/refs")
        ? Response.json(names.map((name) => ({ type: "branch", name })))
        : Response.json(MERGED_MR);

  await t.step("веток вне пайплайна нет — (нет)", async () => {
    const stand = startFakeGitlab(branchesFor(["trunk"]));
    try {
      const result = await runGlabStatus(
        args({ mr: ["group/repo!457"] }),
        ioTo(stand.baseUrl),
        { runGit: noGit, columns: null },
      );
      assertEquals(result.rows[0].other_branches, []);
      assertStringIncludes(
        renderGlabStatus(result, args()),
        "прочие ветки: (нет)\n",
      );
    } finally {
      await stand.stop();
    }
  });

  await t.step(
    "без --branches — счёт и подсказка, с ним — список",
    async () => {
      const stand = startFakeGitlab(branchesFor(["trunk", "хотфикс", "релиз"]));
      try {
        const result = await runGlabStatus(
          args({ mr: ["group/repo!457"] }),
          ioTo(stand.baseUrl),
          { runGit: noGit, columns: null },
        );
        assertStringIncludes(
          renderGlabStatus(result, args()),
          "прочие ветки: 2 (показать: --branches)\n",
        );
        assertStringIncludes(
          renderGlabStatus(result, args({ branches: true })),
          "прочие ветки: релиз, хотфикс\n",
        );
      } finally {
        await stand.stop();
      }
    },
  );

  await t.step("несколько MR — строка на каждый с отступом", async () => {
    const stand = startFakeGitlab((seen) => {
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
      assertStringIncludes(text, "прочие ветки:\n");
      assertStringIncludes(text, "  group/repo!457: (нет)\n");
      assertStringIncludes(text, "  group/repo!458: (нет)\n");
    } finally {
      await stand.stop();
    }
  });
});

Deno.test("мои MR: порядок строк (repo, iid) и отсев без project", async () => {
  const url = (project: string, iid: number) =>
    `https://gitlab.example.test/${project}/-/merge_requests/${iid}`;
  const mine = [
    { ...OPEN_MR, iid: 9, web_url: url("wb/sw-back", 9) },
    { ...OPEN_MR, iid: 2, web_url: url("wb/sl-front", 2) },
    { ...OPEN_MR, iid: 1, web_url: url("wb/sw-back", 1) },
    // Без маркера `/-/` project не определяется — строка отпадает.
    { ...OPEN_MR, iid: 7, web_url: "https://gitlab.example.test/wb/sw-back" },
  ];
  const stand = startFakeGitlab(() => Response.json(mine));
  try {
    const result = await runGlabStatus(args(), ioTo(stand.baseUrl), {
      runGit: noGit,
      nowSeconds: 1_800_000_000,
      columns: null,
    });
    assertEquals(
      result.rows.map((row) => `${row.repo}!${row.iid}`),
      ["sl-front!2", "sw-back!1", "sw-back!9"],
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("--repos: префикс wb/, пустые сегменты, только запятые", () => {
  assertEquals(parseRepos(["sw-front"]), ["wb/sw-front"]);
  assertEquals(parseRepos(["wb/sl-back, sw-back"]), [
    "wb/sl-back",
    "wb/sw-back",
  ]);
  assertEquals(parseRepos(["a", "b,c"]), ["wb/a", "wb/b", "wb/c"]);
  // Только разделители — пустой фильтр: валидный вызов с пустым
  // результатом, а не ошибка.
  assertEquals(parseRepos([" , , "]), []);
});
