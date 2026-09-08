/**
 * Дерево-фикстура спеки для тестов слоя `code`. Отдельным модулем, а не
 * внутри `_test.ts`: помощник, импортированный из чужого теста,
 * регистрирует его случаи вторым прогоном — так же, как это делает
 * `src/testing/mod.ts` для общих помощников.
 */

import type { TreeMark } from "./mark.ts";
import type { Repo } from "./workspace.ts";

/** Постоянная отметка дерева: у фикстуры нет `.git`, и это ответ. */
const OUT_OF_GIT: TreeMark = { repo: "fixture", state: { kind: "out-of-git" } };

/**
 * Материализует дерево-фикстуру в подкаталог `fixture` временного
 * каталога и отдаёт его как репозиторий рабочей области.
 */
export async function openFixture(
  temp: string,
  mark: TreeMark = OUT_OF_GIT,
): Promise<Repo> {
  const root = `${temp}/fixture`;
  const source = new URL("testdata/code/tree/", import.meta.url);
  for (const path of await treeFiles(source, "")) {
    const target = `${root}/${path.replace(/\.txt$/, "")}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      target,
      await Deno.readTextFile(new URL(path, source)),
    );
  }
  return { name: "fixture", root, mark: () => Promise.resolve(mark) };
}

/** Пути файлов поддерева относительно его корня. */
async function treeFiles(dir: URL, prefix: string): Promise<readonly string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      found.push(
        ...await treeFiles(
          new URL(`${entry.name}/`, dir),
          `${prefix}${entry.name}/`,
        ),
      );
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found;
}
