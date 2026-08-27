/**
 * Резолв MR-адреса (`platform/gitlab-api.md`): формы селектора, разбор
 * git remote, определение iid по ветке и тексты отказов.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type GitlabAccess } from "./http.ts";
import {
  type GitOutcome,
  MrRefError,
  parseRemoteUrl,
  type ResolveContext,
  resolveMr,
  type RunGit,
} from "./resolve.ts";
import { startFakeGitlab } from "./testing.ts";

const BASE = "https://gitlab.example.test";
const access = (baseUrl = BASE): GitlabAccess => ({ baseUrl, token: "t" });

const ok = (stdout: string): GitOutcome => ({ code: 0, stdout, stderr: "" });

/** git, который падает при первом же вызове: «сюда ходить не должны». */
const noGit: RunGit = () => {
  throw new Error("git must not be run");
};

const context = (
  runGit: RunGit = noGit,
  baseUrl = BASE,
): ResolveContext => ({ access: access(baseUrl), cwd: "/repo", runGit });

Deno.test("полный селектор не запускает git вовсе", async (t) => {
  await t.step("group/repo!iid", async () => {
    assertEquals(await resolveMr(context(), "group/repo!456"), {
      project: "group/repo",
      iid: 456,
    });
  });

  await t.step("URL с хвостом после iid", async () => {
    assertEquals(
      await resolveMr(
        context(),
        `${BASE}/group/repo/-/merge_requests/456/diffs?tab=x`,
      ),
      { project: "group/repo", iid: 456 },
    );
  });
});

Deno.test("селектор чужого хоста отклоняется, даже структурно валидный", async () => {
  const err = await assertRejects(
    () =>
      resolveMr(context(), "https://gitlab.other.test/g/r/-/merge_requests/1"),
    MrRefError,
    "хост MR-URL 'gitlab.other.test' != 'gitlab.example.test'",
  );
  // Ошибка ввода: она разбирается до всякого обращения наружу.
  assertEquals(err.input, true);
});

Deno.test("неразбираемый селектор — ошибка ввода с перечнем форм", async () => {
  const err = await assertRejects(
    () => resolveMr(context(), "чепуха"),
    MrRefError,
    "формы: URL | 'group/repo!iid' | iid",
  );
  assertEquals(err.input, true);
  await assertRejects(
    () => resolveMr(context(), "group/repo!не-число"),
    MrRefError,
    "ожидается 'group/repo!iid', получено 'group/repo!не-число'",
  );
});

Deno.test("git remote: формы ssh, scp и https", () => {
  assertEquals(parseRemoteUrl("git@gitlab.example.test:group/repo.git"), {
    host: "gitlab.example.test",
    path: "group/repo.git",
  });
  assertEquals(
    parseRemoteUrl("ssh://git@gitlab.example.test:2222/group/repo.git"),
    {
      host: "gitlab.example.test",
      path: "/group/repo.git",
    },
  );
  assertEquals(parseRemoteUrl("https://gitlab.example.test/group/repo.git"), {
    host: "gitlab.example.test",
    path: "/group/repo.git",
  });
  assertEquals(parseRemoteUrl("не-адрес"), null);
});

Deno.test("iid берётся у единственного открытого MR ветки", async () => {
  const stand = startFakeGitlab(() =>
    Response.json([{ iid: 77, title: "заголовок" }])
  );
  try {
    const runGit: RunGit = (args) =>
      Promise.resolve(
        args[0] === "remote"
          ? ok("git@127.0.0.1:group/repo.git")
          : ok("feat/branch"),
      );
    assertEquals(await resolveMr(context(runGit, stand.baseUrl), undefined), {
      project: "group/repo",
      iid: 77,
    });
    assertEquals(
      stand.seen[0].search,
      "?source_branch=feat%2Fbranch&state=opened&per_page=100&page=1",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("ноль и несколько открытых MR — отказ состояния, не ввода", async (t) => {
  const runGit: RunGit = (args) =>
    Promise.resolve(
      args[0] === "remote" ? ok("git@127.0.0.1:group/repo.git") : ok("feat/b"),
    );

  await t.step("ноль", async () => {
    const stand = startFakeGitlab(() => Response.json([]));
    try {
      const err = await assertRejects(
        () => resolveMr(context(runGit, stand.baseUrl), undefined),
        MrRefError,
        "нет открытого MR ветки 'feat/b' в group/repo — укажи --mr",
      );
      assertEquals(err.input, false);
    } finally {
      await stand.stop();
    }
  });

  await t.step("несколько — перечислены с заголовками", async () => {
    const stand = startFakeGitlab(() =>
      Response.json([{ iid: 1, title: "первый" }, { iid: 2, title: "второй" }])
    );
    try {
      await assertRejects(
        () => resolveMr(context(runGit, stand.baseUrl), undefined),
        MrRefError,
        "несколько открытых MR ветки 'feat/b': group/repo!1 первый; " +
          "group/repo!2 второй — укажи --mr",
      );
    } finally {
      await stand.stop();
    }
  });
});

Deno.test("исходы git: нет в PATH, ненулевой код, detached HEAD", async (t) => {
  await t.step("git не найден", async () => {
    await assertRejects(
      () => resolveMr(context(() => Promise.resolve(null)), undefined),
      MrRefError,
      "git не найден в PATH — укажи MR через --mr",
    );
  });

  await t.step("ненулевой код — stderr как причина", async () => {
    const runGit: RunGit = () =>
      Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no origin\n" });
    await assertRejects(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "fatal: no origin — укажи MR через --mr",
    );
  });

  await t.step("detached HEAD", async () => {
    const runGit: RunGit = (args) =>
      Promise.resolve(
        args[0] === "remote"
          ? ok("git@gitlab.example.test:g/r.git")
          : ok("HEAD"),
      );
    await assertRejects(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "detached HEAD — не определить ветку, укажи MR через --mr",
    );
  });

  await t.step("remote смотрит на чужой хост", async () => {
    const runGit: RunGit = () => Promise.resolve(ok("git@github.com:g/r.git"));
    await assertRejects(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "git remote смотрит на 'github.com', а не на 'gitlab.example.test'",
    );
  });
});
