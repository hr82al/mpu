/**
 * Отказ раздела (`platform/code-analyzer.md`): программа проекта не
 * строится.
 *
 * Отказ печатается ВМЕСТО перечня в своём разделе и в stdout, а не
 * уходит в stderr: он относится к репозиторию, а не к вызову. Замер
 * спецификатора 2026-09-08: один репозиторий без установленных
 * зависимостей обнулял ответ по всем восьми.
 */

import { assertEquals } from "@std/assert";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { refsResultSchema } from "./refs.ts";
import { openBrokenFixture } from "./testing.ts";

Deno.test("отказ раздела совпадает с голденом спеки", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openBrokenFixture(temp);
    const result = await runRefs(
      { address: "broken-fixture:src/a.ts:4", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    assertEquals(
      renderRefs(result),
      await Deno.readTextFile(
        new URL("testdata/code/refs-refused.stdout.txt", import.meta.url),
      ),
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("у отказавшего раздела нет ни гарантии, ни разделов", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openBrokenFixture(temp);
    const result = await runRefs(
      { address: "broken-fixture:src/a.ts:4", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );

    await t.step("раздел размечен как отказавший", () => {
      // Гарантия — свойство ответа: она говорит, насколько полон
      // перечень. Там, где перечня нет, заявлять о полноте нечего, и
      // типом такого состояния просто не существует.
      assertEquals(result.section.kind, "refused");
    });

    await t.step("причина названа и указывает на конфигурацию", () => {
      const section = result.section;
      if (section.kind !== "refused") throw new Error("раздел не отказал");
      assertEquals(
        section.refusal,
        "конфигурация проекта tsconfig.json не разбирается: " +
          "File '@nowhere/base.json' not found.",
      );
    });

    await t.step("ответ проходит объявленную схему", () => {
      // Отказ — такой же ответ команды, и схема результата обязана его
      // принимать: иначе точка входа отдала бы его агенту не по схеме.
      refsResultSchema.parse(result);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
