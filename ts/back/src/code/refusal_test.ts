/**
 * Отказ раздела (`platform/code-analyzer.md`). Условий здесь два, и
 * причина у каждого своя: программа проекта не строится (ошибка
 * конфигурации) — и конфигурации есть, а непустого состава ни у одной.
 *
 * Отказ печатается ВМЕСТО перечня в своём разделе и в stdout, а не
 * уходит в stderr: он относится к репозиторию, а не к вызову. Замер
 * спецификатора 2026-09-08: один репозиторий без установленных
 * зависимостей обнулял ответ по всем восьми.
 */

import { assertEquals } from "@std/assert";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { runName } from "./cmd_name.ts";
import { refsResultSchema } from "./refs.ts";
import { openBrokenFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

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
      assertEquals(section.kind, "refused", JSON.stringify(section));
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

/** Репозиторий с конфигурацией, у которой нет ни одного исходника. */
async function hollowRepo(
  root: string,
  config: "tsconfig" | "deno",
): Promise<Repo> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  const [name, text] = config === "deno" ? ["deno.json", "{}\n"] : [
    "tsconfig.json",
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  ];
  await Deno.writeTextFile(`${root}/${name}`, text);
  return {
    name: "hollow",
    root,
    mark: () =>
      Promise.resolve({ repo: "hollow", state: { kind: "out-of-git" } }),
  };
}

Deno.test("проекты есть, а программ нет — причина называет это", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // Конфигурация есть, а состава у неё нет: `include` указывает в
    // пустой каталог. «Нет ни одного проекта» здесь было бы неправдой —
    // искать пришлось бы не то, чего не хватает.
    const repo = await hollowRepo(`${temp}/hollow`, "tsconfig");
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    // Один репозиторий — один раздел; иначе проверка утверждала бы про
    // не тот.
    assertEquals(result.sections.length, 1);
    const section = result.sections[0];
    assertEquals(section.kind, "refused", JSON.stringify(section));
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    assertEquals(
      section.refusal,
      "объявления не разбираются текстовым анализатором: в репозитории " +
        "hollow есть конфигурации проектов, но ни одна программа не " +
        "собралась непустой",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("та же причина у deno-конфигурации и у адреса", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    await t.step("deno.json без единого исходника", async () => {
      // Второй путь к пустому составу структурно отдельный: у deno
      // состав снимается обходом дерева, а не разбором `include`.
      const repo = await hollowRepo(`${temp}/deno`, "deno");
      const result = await runName(
        { name: "alpha", in: undefined, limit: 200 },
        { cwd: () => repo.root },
        [repo],
      );
      assertEquals(result.sections.length, 1);
      const section = result.sections[0];
      assertEquals(section.kind, "refused", JSON.stringify(section));
      if (section.kind !== "refused") throw new Error("раздел не отказал");
      assertEquals(
        section.refusal,
        "объявления не разбираются текстовым анализатором: в репозитории " +
          "hollow есть конфигурации проектов, но ни одна программа не " +
          "собралась непустой",
      );
    });

    await t.step("адрес символа получает ту же причину", async () => {
      // `refs`/`twins` открывают анализатор другим входом, и до этой
      // порции он отвечал «файл не входит ни в один проект» — причина
      // не та: программ здесь не построилось вовсе.
      const repo = await hollowRepo(`${temp}/addr`, "tsconfig");
      await Deno.writeTextFile(
        `${repo.root}/lonely.ts`,
        "export const a = 1;\n",
      );
      const result = await runRefs(
        { address: "hollow:lonely.ts:1", limit: 200 },
        { cwd: () => repo.root },
        [repo],
      );
      const section = result.section;
      assertEquals(section.kind, "refused", JSON.stringify(section));
      if (section.kind !== "refused") throw new Error("раздел не отказал");
      assertEquals(
        section.refusal,
        "объявления не разбираются текстовым анализатором: в репозитории " +
          "hollow есть конфигурации проектов, но ни одна программа не " +
          "собралась непустой",
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("одна конфигурация пуста, другая собралась — репозиторий отвечает", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // Граница отказа — «не собралось НИ ОДНОЙ», а не «какая-то не
    // собралась»: соседний рабочий проект лёг бы вместе с пустой
    // конфигурацией.
    const root = `${temp}/mixed`;
    await Deno.mkdir(`${root}/empty/src`, { recursive: true });
    await Deno.mkdir(`${root}/works/src`, { recursive: true });
    const config =
      '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n';
    await Deno.writeTextFile(`${root}/empty/tsconfig.json`, config);
    await Deno.writeTextFile(`${root}/works/tsconfig.json`, config);
    await Deno.writeTextFile(
      `${root}/works/src/a.ts`,
      "export function alpha(): number {\n  return 1;\n}\n",
    );
    const repo: Repo = {
      name: "mixed",
      root,
      mark: () =>
        Promise.resolve({ repo: "mixed", state: { kind: "out-of-git" } }),
    };
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => root },
      [repo],
    );
    const section = result.sections[0];
    assertEquals(section.kind, "answer", JSON.stringify(section));
    if (section.kind !== "answer") throw new Error("раздел отказал");
    assertEquals(section.declarations.total, 1);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
