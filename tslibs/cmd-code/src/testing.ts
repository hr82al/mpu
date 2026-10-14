/**
 * Деревья тестов слоя `code`: фикстуры спеки и временные репозитории
 * (в том числе под git) на время `describe`. Отдельным модулем, а не
 * внутри `_test.ts`: помощник, импортированный из чужого теста,
 * регистрирует его случаи вторым прогоном — так же, как это делает
 * `@mpu/command/testing` для общих помощников.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { spawnGit } from "./git.ts";
import type { TreeMark } from "./mark.ts";
import type { Repo } from "./workspace.ts";

/** Постоянная отметка дерева: у фикстуры нет `.git`, и это ответ. */
const OUT_OF_GIT: TreeMark = { repo: "fixture", state: { kind: "out-of-git" } };

/**
 * Дерево-фикстура вида Deno под именем `deno-fixture`. Свой `deno.json`
 * у неё обязателен и кладётся в корень материализованного дерева:
 * иначе ближайшей конфигурацией окажется чужая, и ответ станет зависеть
 * от места прогона.
 */
export async function openDenoFixture(temp: string): Promise<Repo> {
  return await materialize(temp, "deno-fixture", "testdata/code/deno-tree/", {
    repo: "deno-fixture",
    state: { kind: "out-of-git" },
  });
}

/**
 * Материализует дерево-фикстуру в подкаталог `fixture` временного
 * каталога и отдаёт его как репозиторий рабочей области.
 */
export async function openFixture(
  temp: string,
  mark: TreeMark = OUT_OF_GIT,
): Promise<Repo> {
  return await materialize(temp, "fixture", "testdata/code/tree/", mark);
}

/**
 * Дерево, у которого конфигурация проекта наследует пакет, которого
 * нет: программа не строится, и раздел обязан назвать отказ, а не
 * подменить его пустым перечнем.
 */
export async function openBrokenFixture(temp: string): Promise<Repo> {
  return await materialize(
    temp,
    "broken-fixture",
    "testdata/code/broken-tree/",
    {
      repo: "broken-fixture",
      state: { kind: "out-of-git" },
    },
  );
}

/**
 * Дерево литералов (`specs/code-literals.md`, «Сценарии») под именем
 * `fixture`: своё, потому что общее дерево сканируют голдены `name`,
 * `refs`, `twins`, `mentions`, и лишний файл в нём менял бы их ответы.
 */
export async function openLiteralsFixture(temp: string): Promise<Repo> {
  return await materialize(
    temp,
    "fixture",
    "testdata/code/literals-tree/",
    OUT_OF_GIT,
  );
}

/** Раскладывает дерево канала во временный каталог под именем `name`. */
async function materialize(
  temp: string,
  name: string,
  from: string,
  mark: TreeMark,
): Promise<Repo> {
  const root = `${temp}/${name}`;
  const source = new URL(from, import.meta.url);
  for (const path of await treeFiles(source, "")) {
    const target = `${root}/${path.replace(/\.txt$/, "")}`;
    await mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await writeFile(target, await readFile(new URL(path, source), "utf8"));
  }
  return { name, root, mark: () => Promise.resolve(mark) };
}

/** Пути файлов поддерева относительно его корня. */
async function treeFiles(dir: URL, prefix: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(
        ...(await treeFiles(
          new URL(`${entry.name}/`, dir),
          `${prefix}${entry.name}/`,
        )),
      );
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found;
}

/** Префикс временных каталогов теста. */
export const TEMP_PREFIX = join(tmpdir(), "mpu-");

/** Кладёт файл в дерево репозитория. */
export async function put(
  repo: Repo,
  path: string,
  text: string,
): Promise<void> {
  const target = `${repo.root}/${path}`;
  await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await writeFile(target, text);
}

/**
 * Репозиторий во временном каталоге на время `describe`, с уборкой;
 * `open` раскладывает его в каталоге.
 */
export function treeOf(open: (temp: string) => Promise<Repo>): () => Repo {
  let temp = "";
  let repo = (): Repo => {
    throw new Error("дерево теста не открыто");
  };
  beforeAll(async () => {
    temp = await mkdtemp(TEMP_PREFIX);
    const opened = await open(temp);
    repo = () => opened;
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  return () => repo();
}

/** Git с identity коммита в аргументах: глобального конфига может не быть. */
export async function git(cwd: string, args: readonly string[]): Promise<void> {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const result = await spawnGit([...identity, ...args], cwd);
  expect(result?.code, `git ${args.join(" ")}`).toBe(0);
}

/** Первый коммит всего, что лежит в `root`. */
export async function commitAll(root: string): Promise<void> {
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "--message", "seed"]);
}
