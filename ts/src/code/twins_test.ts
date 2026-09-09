/**
 * `mpu code twins` против golden-эталонов спеки (`specs/code-twins.md`).
 *
 * Главное здесь — что сравниваются тела, а не имена: три побайтово
 * равных тела фикстуры носят три разных имени, и учёт имени оставил бы
 * от ответа одно совпадение из трёх.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { codeTwinsCommand, renderTwins, runTwins } from "./cmd_twins.ts";
import { openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/** Прогон команды на фикстуре: рабочий каталог — корень репозитория. */
async function twins(
  repo: Repo,
  address: string,
  limit = 200,
): Promise<string> {
  const result = await runTwins({ address, limit }, { cwd: () => repo.root }, [
    repo,
  ]);
  return renderTwins(result);
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`testdata/code/${name}`, import.meta.url),
  );
}

Deno.test("twins на дереве-фикстуре совпадает с голденами спеки", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const cases: readonly (readonly [string, string])[] = [
      ["fixture:src/window.ts:4", "twins-exact.stdout.txt"],
      ["fixture:src/loaderA.ts:2", "twins-similar.stdout.txt"],
    ];
    for (const [address, name] of cases) {
      await t.step(name, async () => {
        assertEquals(await twins(repo, address), await golden(name));
      });
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("тело берётся у объявления, охватывающего строку", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);

    await t.step("строка внутри тела, а не строка объявления", async () => {
      // Пятая строка `window.ts` — середина тела; объявление начинается
      // четвёртой, и ответ обязан быть тем же.
      assertEquals(
        await twins(repo, "fixture:src/window.ts:5"),
        await golden("twins-exact.stdout.txt"),
      );
    });

    await t.step("строка вне всякого объявления — ошибка ввода", async () => {
      const err = await assertRejects(
        () => twins(repo, "fixture:src/window.ts:1"),
        UsageError,
      );
      assertEquals(err.message, "в строке 1 нет объявления-функции");
      assertEquals(err.details, "  src/window.ts:4  windowDays");
    });

    await t.step("адрес без строки — ошибка ввода", async () => {
      const err = await assertRejects(
        () => twins(repo, "fixture:src/window.ts"),
        UsageError,
      );
      assertEquals(
        err.message,
        "нужна строка: тело берётся у объявления, охватывающего её",
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("близнецов нет — ответ, а не отказ", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    // `addDays` уникален в дереве: раздел «побайтово» несёт только сам
    // запрос, «похоже» пуст — и это ответ.
    const text = await twins(repo, "fixture:src/days.ts:2");
    assertEquals(
      text.includes("побайтово: 1\n  src/days.ts:2  addDays"),
      true,
      text,
    );
    assertEquals(text.includes("похоже: 0"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("усечение — не ошибка: раздел говорит о нём сам", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const text = await twins(repo, "fixture:src/window.ts:4", 2);
    assertEquals(text.includes("побайтово: 3"), true, text);
    assertEquals(text.includes("  усечено: показано 2 из 3"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("репозиторий без проектов: тела не разбираются — отказ", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/plain`;
    await Deno.mkdir(`${root}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/src/a.ts`,
      "export function one() {\n  return 1;\n}\n",
    );
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // Пустые разделы читались бы как «близнецов нет», а это другой
    // ответ: выделить тело без разбора нечем.
    const result = await runTwins(
      { address: "plain:src/a.ts:1", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    const section = result.section;
    assertEquals(section.kind, "refused", JSON.stringify(section));
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    assertEquals(
      section.refusal,
      "тела не разбираются текстовым анализатором: " +
        "в репозитории plain нет ни одного проекта",
    );
    // Отметку дерева несёт каждый раздел, включая отказавший.
    assertEquals(section.mark.repo, "plain");
    assertEquals(codeTwinsCommand.textExitCode(result), 1);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
