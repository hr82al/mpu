/**
 * Рабочая область: поиск корня по сентинелу и состав репозиториев
 * (`platform/code-analyzer.md`, «Ввод/вывод», «Граничные случаи»).
 */

import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("корень рабочей области ищется по сентинелу", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/mp`;
    await Deno.mkdir(`${root}/ozon/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/${SENTINEL}`, "");

    await t.step("ближайший предок с сентинелом", () => {
      assertEquals(findWorkspaceRoot(`${root}/ozon/src`), root);
      assertEquals(findWorkspaceRoot(root), root);
    });

    await t.step("сентинела нет ни у одного предка — отказ слоя", () => {
      const err = assertThrows(
        () => findWorkspaceRoot("/nowhere/deep"),
        VerbatimError,
      );
      assertEquals(
        err.message,
        `mpu code: рабочая область не найдена: сентинела ${SENTINEL} нет ни у одного предка /nowhere/deep`,
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("репозитории — подкаталоги первого уровня с .git", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/mp`;
    await Deno.mkdir(`${root}/ozon/.git`, { recursive: true });
    await Deno.mkdir(`${root}/wb/.git`, { recursive: true });
    // Каталог без `.git` и обычный файл репозиториями не считаются.
    await Deno.mkdir(`${root}/scratch`, { recursive: true });
    await Deno.writeTextFile(`${root}/${SENTINEL}`, "");

    await t.step("состав и порядок", () => {
      const repos = readRepos(root, NO_GIT);
      assertEquals(repos.map((repo) => repo.name), ["ozon", "wb"]);
      assertEquals(repos[0].root, `${root}/ozon`);
    });

    await t.step("репозиторий текущего каталога", () => {
      const repos = readRepos(root, NO_GIT);
      assertEquals(repoOf(repos, `${root}/wb/src/deep`)?.name, "wb");
      assertEquals(repoOf(repos, `${root}/scratch`), undefined);
      // Имя-префикс соседа своим репозиторием не притворяется.
      assertEquals(
        repoOf([{ name: "wb", root: "/w/wb" } as Repo], "/w/wbx"),
        undefined,
      );
    });

    await t.step("ни одного репозитория — отказ слоя", async () => {
      const empty = `${temp}/empty`;
      await Deno.mkdir(empty, { recursive: true });
      const err = assertThrows(() => readRepos(empty, NO_GIT), VerbatimError);
      assertEquals(err.message, "mpu code: в рабочей области нет репозиториев");
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
