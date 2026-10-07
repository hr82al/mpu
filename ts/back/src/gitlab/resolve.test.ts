/**
 * Резолв MR-адреса (`platform/gitlab-api.md`): формы селектора, разбор
 * git remote, определение iid по ветке и тексты отказов.
 */

import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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

describe("полный селектор не запускает git вовсе", () => {
  it("group/repo!iid", async () => {
    expect(await resolveMr(context(), "group/repo!456")).toStrictEqual({
      project: "group/repo",
      iid: 456,
    });
  });

  it("URL с хвостом после iid", async () => {
    expect(
      await resolveMr(
        context(),
        `${BASE}/group/repo/-/merge_requests/456/diffs?tab=x`,
      ),
    ).toStrictEqual({ project: "group/repo", iid: 456 });
  });
});

it("селектор чужого хоста отклоняется, даже структурно валидный", async () => {
  const err = await rejected(
    () =>
      resolveMr(context(), "https://gitlab.other.test/g/r/-/merge_requests/1"),
    MrRefError,
    "хост MR-URL 'gitlab.other.test' != 'gitlab.example.test'",
  );
  // Ошибка ввода: она разбирается до всякого обращения наружу.
  expect(err.input).toBe(true);
});

it("неразбираемый селектор — ошибка ввода с перечнем форм", async () => {
  const err = await rejected(
    () => resolveMr(context(), "чепуха"),
    MrRefError,
    "формы: URL | 'group/repo!iid' | iid",
  );
  expect(err.input).toBe(true);
  await rejected(
    () => resolveMr(context(), "group/repo!не-число"),
    MrRefError,
    "ожидается 'group/repo!iid', получено 'group/repo!не-число'",
  );
});

it("git remote: формы ssh, scp и https", () => {
  expect(parseRemoteUrl("git@gitlab.example.test:group/repo.git"))
    .toStrictEqual({
      host: "gitlab.example.test",
      path: "group/repo.git",
    });
  expect(parseRemoteUrl("ssh://git@gitlab.example.test:2222/group/repo.git"))
    .toStrictEqual({
      host: "gitlab.example.test",
      path: "/group/repo.git",
    });
  expect(parseRemoteUrl("https://gitlab.example.test/group/repo.git"))
    .toStrictEqual({
      host: "gitlab.example.test",
      path: "/group/repo.git",
    });
  expect(parseRemoteUrl("не-адрес")).toStrictEqual(null);
});

it("iid берётся у единственного открытого MR ветки", async () => {
  const stand = await startFakeGitlab(() =>
    Response.json([{ iid: 77, title: "заголовок" }])
  );
  try {
    const runGit: RunGit = (args) =>
      Promise.resolve(
        args[0] === "remote"
          ? ok("git@127.0.0.1:group/repo.git")
          : ok("feat/branch"),
      );
    expect(await resolveMr(context(runGit, stand.baseUrl), undefined))
      .toStrictEqual({
        project: "group/repo",
        iid: 77,
      });
    expect(stand.seen[0].search).toBe(
      "?source_branch=feat%2Fbranch&state=opened&per_page=100&page=1",
    );
  } finally {
    await stand.stop();
  }
});

describe("ноль и несколько открытых MR — отказ состояния, не ввода", () => {
  const runGit: RunGit = (args) =>
    Promise.resolve(
      args[0] === "remote" ? ok("git@127.0.0.1:group/repo.git") : ok("feat/b"),
    );

  it("ноль", async () => {
    const stand = await startFakeGitlab(() => Response.json([]));
    try {
      const err = await rejected(
        () => resolveMr(context(runGit, stand.baseUrl), undefined),
        MrRefError,
        "нет открытого MR ветки 'feat/b' в group/repo — укажи --mr",
      );
      expect(err.input).toBe(false);
    } finally {
      await stand.stop();
    }
  });

  it("несколько — перечислены с заголовками", async () => {
    const stand = await startFakeGitlab(() =>
      Response.json([{ iid: 1, title: "первый" }, { iid: 2, title: "второй" }])
    );
    try {
      await rejected(
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

describe("исходы git: нет в PATH, ненулевой код, detached HEAD", () => {
  it("git не найден", async () => {
    await rejected(
      () => resolveMr(context(() => Promise.resolve(null)), undefined),
      MrRefError,
      "git не найден в PATH — укажи MR через --mr",
    );
  });

  it("ненулевой код — stderr как причина", async () => {
    const runGit: RunGit = () =>
      Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no origin\n" });
    await rejected(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "fatal: no origin — укажи MR через --mr",
    );
  });

  it("detached HEAD", async () => {
    const runGit: RunGit = (args) =>
      Promise.resolve(
        args[0] === "remote"
          ? ok("git@gitlab.example.test:g/r.git")
          : ok("HEAD"),
      );
    await rejected(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "detached HEAD — не определить ветку, укажи MR через --mr",
    );
  });

  it("remote смотрит на чужой хост", async () => {
    const runGit: RunGit = () => Promise.resolve(ok("git@github.com:g/r.git"));
    await rejected(
      () => resolveMr(context(runGit), undefined),
      MrRefError,
      "git remote смотрит на 'github.com', а не на 'gitlab.example.test'",
    );
  });
});
