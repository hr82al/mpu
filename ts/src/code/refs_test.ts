/**
 * `mpu code refs` против golden-эталонов спеки (`specs/code-refs.md`).
 *
 * Дерево-фикстура материализуется во временный каталог с именем
 * `fixture`: имя репозитория в голденах именно это, и от имени
 * временного каталога зависеть не должно. Расширение `.txt` снимается
 * при материализации — файлы `.ts` в канале спецификаций попали бы под
 * гейты модуля.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/** Прогон команды на фикстуре: рабочий каталог — корень репозитория. */
async function refs(
  repo: Repo,
  address: string,
  limit = 200,
): Promise<string> {
  const result = await runRefs({ address, limit }, { cwd: () => repo.root }, [
    repo,
  ]);
  return renderRefs(result);
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`testdata/code/${name}`, import.meta.url),
  );
}

Deno.test("refs на дереве-фикстуре совпадает с голденами спеки", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const cases: readonly (readonly [string, string])[] = [
      ["fixture:src/days.ts:2", "refs-symbol.stdout.txt"],
      ["fixture:src/window.ts", "refs-module.stdout.txt"],
      ["fixture:src/orphan.ts:2", "refs-orphan.stdout.txt"],
    ];
    for (const [address, name] of cases) {
      await t.step(name, async () => {
        assertEquals(await refs(repo, address), await golden(name));
      });
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("два вызова на неизменном дереве дают один и тот же текст", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const first = await refs(repo, "fixture:src/days.ts:2");
    assertEquals(await refs(repo, "fixture:src/days.ts:2"), first);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("отметка дерева под git печатается обоими видами", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const cases: readonly (readonly [string, boolean, string])[] = [
      ["чистое дерево", false, "дерево чистое"],
      ["с изменениями", true, "дерево содержит незакоммиченные изменения"],
    ];
    for (const [title, dirty, state] of cases) {
      await t.step(title, async () => {
        const repo = await openFixture(`${temp}/${dirty}`, {
          repo: "fixture",
          state: {
            kind: "git",
            branch: "feat/checklist/serving/screen-data-endpoint",
            commit: "989c0bf9",
            dirty,
          },
        });
        const text = await refs(repo, "fixture:src/days.ts:2");
        assertEquals(
          text.split("\n")[0],
          `fixture · feat/checklist/serving/screen-data-endpoint · 989c0bf9 · ${state} · разбор по типам — ответ полон`,
        );
      });
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("ошибки ввода: репозиторий, файл, строка без объявления", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    await t.step("неизвестный репозиторий", async () => {
      const err = await assertRejects(
        () => refs(repo, "nope:src/days.ts:2"),
        UsageError,
      );
      assertEquals(err.message, "неизвестный репозиторий 'nope'");
      assertEquals(err.details, "  fixture");
    });
    await t.step("файла нет", async () => {
      const err = await assertRejects(
        () => refs(repo, "fixture:src/gone.ts"),
        UsageError,
      );
      assertEquals(err.message, "файла src/gone.ts нет в fixture на вне git");
    });
    await t.step("в строке нет объявления", async () => {
      const err = await assertRejects(
        () => refs(repo, "fixture:src/days.ts:1"),
        UsageError,
      );
      assertEquals(err.message, "в строке 1 нет объявления");
      assertEquals(
        err.details,
        "  src/days.ts:2  addDays\n  src/days.ts:9  spanDays",
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("усечение — не ошибка: раздел говорит о нём сам", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);
    const text = await refs(repo, "fixture:src/days.ts:2", 2);
    assertEquals(text.includes("потребители: 6 файлов"), true);
    assertEquals(text.includes("  усечено: показано 2 из 6"), true);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
