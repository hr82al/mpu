/**
 * Обход репозиториев: порядок разделов и порядок отказов.
 *
 * Разница во времени строится по-разному и намеренно. Порядок разделов
 * и порядок отказа разделов проверяются на репозиториях РАЗНОГО веса, в
 * порядке «тяжёлый первым»: обход параллельный, и одинаковые по
 * стоимости репозитории зеленели бы при любой реализации — включая ту,
 * что печатает по готовности. Порядок отказа ОТМЕТКИ так не построить —
 * git в тестах подставлен, — и разницу там дают такты микрозадач.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { runName } from "./cmd_name.ts";
import { collectName } from "./name.ts";
import type { TreeMark } from "./mark.ts";
import type { Repo } from "./workspace.ts";

/** Репозиторий с проектом из `count` файлов. Вес задаёт их число. */
async function project(root: string, count: number): Promise<Repo> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/tsconfig.json`,
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  );
  for (let at = 0; at < count; at++) {
    await Deno.writeTextFile(
      `${root}/src/f${at}.ts`,
      `export function f${at}(n: number): number {\n  return n + ${at};\n}\n`,
    );
  }
  const name = root.slice(root.lastIndexOf("/") + 1);
  return {
    name,
    root,
    mark: () => Promise.resolve({ repo: name, state: { kind: "out-of-git" } }),
  };
}

Deno.test("разделы идут в порядке перечня, а не готовности", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // Тяжёлый первым: он же и ответит последним.
    const heavy = await project(`${temp}/a-heavy`, 400);
    const light = await project(`${temp}/b-light`, 1);
    const result = await runName(
      { name: "f0", in: undefined, limit: 200 },
      { cwd: () => light.root },
      [heavy, light],
    );
    assertEquals(
      result.sections.map((section) => section.mark.repo),
      ["a-heavy", "b-light"],
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("отказ РАЗДЕЛА выбирается по порядку перечня", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const heavy = await project(`${temp}/a-heavy`, 400);
    const light = await project(`${temp}/b-light`, 1);
    // Каталога окна нет ни в одном репозитории: ошибка ввода приходит
    // из обоих воркеров, и лёгкий отвечает раньше по времени. Назвать
    // надо первый по перечню — иначе текст ошибки зависел бы от того,
    // какой репозиторий больше.
    const err = await assertRejects(
      () =>
        collectName("f0", { repo: undefined, dir: "нет-каталога" }, 200, [
          heavy,
          light,
        ]),
      UsageError,
    );
    assertEquals(
      err.message,
      "каталога 'нет-каталога' нет в a-heavy на вне git",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("отказ ОТМЕТКИ выбирается по порядку перечня", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const light = await project(`${temp}/b-light`, 1);
    // Отметку снимает git, и отказать он может в любом репозитории.
    // Второй отказывает РАНЬШЕ первого по времени: `Promise.all` отдал
    // бы его ошибку, и текст отказа зависел бы от того, чей git
    // ответил быстрее.
    const late = Promise.withResolvers<TreeMark>();
    const first: Repo = {
      name: "a-late",
      root: light.root,
      mark: () => late.promise,
    };
    const second: Repo = {
      name: "b-early",
      root: light.root,
      mark: () => {
        // Отказ первого доставляется ПОЗЖЕ отказа второго, и «позже»
        // здесь считается тактами микрозадач, а не сном: сон в тестах
        // запрещён, а такт детерминирован.
        Promise.resolve()
          .then(() => {})
          .then(() => late.reject(new DomainError("отметка a-late")));
        return Promise.reject(new DomainError("отметка b-early"));
      },
    };
    const err = await assertRejects(
      () =>
        runName(
          { name: "f0", in: undefined, limit: 200 },
          { cwd: () => light.root },
          [first, second],
        ),
      DomainError,
    );
    assertEquals(err.message, "отметка a-late");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
