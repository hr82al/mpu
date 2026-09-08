/**
 * Полнота перечня на деревьях, которых нет в фикстуре спеки
 * (`platform/code-analyzer.md`, «Оракул полноты»).
 *
 * Инвариант один и тот же: перечень равен множеству файлов, которые
 * ломает переименование. Проверяется он здесь с двух сторон — файл,
 * который обязан быть в перечне, и файл, которого в нём быть не должно.
 * Вторая сторона важнее: лишний файл под шапкой «ответ полон» — такой
 * же уверенно неверный ответ, как пропущенный.
 */

import { assertEquals } from "@std/assert";
import { runRefs } from "./cmd_refs.ts";
import type { Repo } from "./workspace.ts";

/** Репозиторий из файлов, заданных путём и содержимым. */
async function repoOf(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Repo> {
  for (const [path, text] of Object.entries(files)) {
    const target = `${root}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(target, text);
  }
  return {
    name: "r",
    root,
    mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
  };
}

/** Пути файлов-потребителей символа по адресу. */
async function consumers(repo: Repo, address: string): Promise<string[]> {
  const result = await runRefs(
    { address, limit: 200 },
    { cwd: () => repo.root },
    [repo],
  );
  return result.consumers.places.map((place) => place.path);
}

const PROJECT = '{"compilerOptions":{"strict":true,"noEmit":true},' +
  '"include":["src/**/*"]}\n';

Deno.test("потребитель из соседнего проекта того же репозитория", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // Два проекта в одном репозитории: ответ по первому попавшемуся
    // был бы пуст — и напечатан под шапкой «ответ полон».
    const repo = await repoOf(`${temp}/r`, {
      "pa/tsconfig.json": PROJECT,
      "pa/src/a.ts":
        "export function addOne(n: number): number {\n  return n + 1;\n}\n",
      "pb/tsconfig.json": PROJECT,
      "pb/src/b.ts":
        "import { addOne } from '../../pa/src/a.ts';\n\nexport const two = addOne(1);\n",
    });
    assertEquals(await consumers(repo, "r:pa/src/a.ts:1"), ["pb/src/b.ts"]);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("в перечень не попадает файл, которого символ не касается", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await repoOf(`${temp}/r`, {
      "tsconfig.json": PROJECT,
      "src/a.ts":
        "export function addOne(n: number): number {\n  return n + 1;\n}\n" +
        "export const other = 1;\n",
      // Берёт символ — обязан быть в перечне.
      "src/uses.ts":
        "import { addOne } from './a.ts';\n\nexport const two = addOne(1);\n",
      // Берёт под другим именем — тоже обязан: сверка идёт символами.
      "src/renamed.ts":
        "import { addOne as plus } from './a.ts';\n\nexport const three = plus(2);\n",
      // Ни один из трёх переименование не ломает.
      "src/side.ts": "import './a.ts';\n\nexport const nothing = 0;\n",
      "src/ns.ts":
        "import * as A from './a.ts';\n\nexport const o = A.other;\n",
      "src/star.ts": "export * from './a.ts';\n",
      // А этот — ломает: символ взят через пространство имён поимённо.
      "src/nsUses.ts":
        "import * as A from './a.ts';\n\nexport const four = A.addOne(3);\n",
    });
    const found = await consumers(repo, "r:src/a.ts:1");

    await t.step("берущие символ — в перечне", () => {
      for (const path of ["src/nsUses.ts", "src/renamed.ts", "src/uses.ts"]) {
        assertEquals(found.includes(path), true, `${path} потерян: ${found}`);
      }
    });

    await t.step("не берущие символ — вне перечня", () => {
      for (const path of ["src/ns.ts", "src/side.ts", "src/star.ts"]) {
        assertEquals(found.includes(path), false, `${path} лишний: ${found}`);
      }
    });

    await t.step("единица перечня — файл, и он в нём один раз", () => {
      assertEquals([...new Set(found)].length, found.length, `${found}`);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("пустая конфигурация рядом не отменяет ответа", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // Solution-style конфиг проектом не считается: он не разрешает ни
    // одного файла. Отказ здесь положил бы ответ по соседнему рабочему
    // проекту того же репозитория.
    const repo = await repoOf(`${temp}/r`, {
      "tsconfig.json": PROJECT,
      "src/a.ts":
        "export function addOne(n: number): number {\n  return n + 1;\n}\n",
      "src/uses.ts":
        "import { addOne } from './a.ts';\n\nexport const two = addOne(1);\n",
      "empty/tsconfig.json": '{"include":["nothing/**/*"]}\n',
    });
    assertEquals(await consumers(repo, "r:src/a.ts:1"), ["src/uses.ts"]);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
