/**
 * Рабочая область: поиск корня по сентинелу и состав репозиториев
 * (`platform/code-analyzer.md`, «Ввод/вывод», «Граничные случаи»).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { VerbatimError } from "../command/mod.ts";
import {
  findWorkspaceRoot,
  readRepos,
  type Repo,
  repoOf,
  SENTINEL,
} from "./workspace.ts";
import type { RunGit } from "./mark.ts";

/** Настоящий git не запускается: дерево тестовое, отметка не проверяется. */
const NO_GIT: RunGit = () => Promise.resolve(null);

describe("корень рабочей области ищется по сентинелу", () => {
  let temp: string;
  let root: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    root = `${temp}/mp`;
    await mkdir(`${root}/ozon/src`, { recursive: true });
    await writeFile(`${root}/${SENTINEL}`, "");
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("ближайший предок с сентинелом", () => {
    expect(findWorkspaceRoot(`${root}/ozon/src`)).toStrictEqual(root);
    expect(findWorkspaceRoot(root)).toStrictEqual(root);
  });

  it("сентинела нет ни у одного предка — отказ слоя", () => {
    let err: unknown;
    try {
      findWorkspaceRoot("/nowhere/deep");
    } catch (thrown) {
      err = thrown;
    }
    assert(err instanceof VerbatimError);
    expect(err.message).toStrictEqual(
      `mpu code: рабочая область не найдена: сентинела ${SENTINEL} нет ни у одного предка /nowhere/deep`,
    );
  });
});

describe("репозитории — подкаталоги первого уровня с .git", () => {
  let temp: string;
  let root: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    root = `${temp}/mp`;
    await mkdir(`${root}/ozon/.git`, { recursive: true });
    await mkdir(`${root}/wb/.git`, { recursive: true });
    // Каталог без `.git` и обычный файл репозиториями не считаются.
    await mkdir(`${root}/scratch`, { recursive: true });
    await writeFile(`${root}/${SENTINEL}`, "");
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("состав и порядок", () => {
    const repos = readRepos(root, NO_GIT);
    expect(repos.map((repo) => repo.name)).toStrictEqual(["ozon", "wb"]);
    expect(repos[0].root).toStrictEqual(`${root}/ozon`);
  });

  it("репозиторий текущего каталога", () => {
    const repos = readRepos(root, NO_GIT);
    expect(repoOf(repos, `${root}/wb/src/deep`)?.name).toBe("wb");
    expect(repoOf(repos, `${root}/scratch`)).toStrictEqual(undefined);
    // Имя-префикс соседа своим репозиторием не притворяется.
    expect(repoOf([{ name: "wb", root: "/w/wb" } as Repo], "/w/wbx"))
      .toStrictEqual(undefined);
  });

  it("ни одного репозитория — отказ слоя", async () => {
    const empty = `${temp}/empty`;
    await mkdir(empty, { recursive: true });
    let err: unknown;
    try {
      readRepos(empty, NO_GIT);
    } catch (thrown) {
      err = thrown;
    }
    assert(err instanceof VerbatimError);
    expect(err.message).toBe("mpu code: в рабочей области нет репозиториев");
  });
});
