/**
 * Объявления, которых нет в деревьях-фикстурах: перегрузки и битый
 * манифест пакета (`specs/code-name.md`).
 *
 * Оба случая про одно и то же — перечень не должен называть форму,
 * которой нет, и не должен молчать о том, чего не выяснил.
 */

import { assertEquals } from "@std/assert";
import { renderName, runName } from "./cmd_name.ts";
import type { Repo } from "./workspace.ts";

const PROJECT = '{"compilerOptions":{"strict":true,"noEmit":true},' +
  '"include":["src/**/*"]}\n';

/** Репозиторий с tsconfig-проектом из заданных файлов. */
async function repoWith(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Repo> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(`${root}/tsconfig.json`, PROJECT);
  for (const [path, text] of Object.entries(files)) {
    await Deno.writeTextFile(`${root}/${path}`, text);
  }
  return {
    name: "r",
    root,
    mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
  };
}

async function name(repo: Repo, what: string): Promise<string> {
  return renderName(
    await runName({ name: what, in: "r", limit: 200 }, {
      cwd: () => repo.root,
    }, [repo]),
  );
}

Deno.test("перегрузка — отдельная запись, реализация — не запись", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await repoWith(`${temp}/r`, {
      "src/a.ts": [
        "export function pick(a: string): string;",
        "export function pick(a: number): number;",
        "export function pick(a: string | number): string | number {",
        "  return a;",
        "}",
        "",
      ].join("\n"),
    });
    const text = await name(repo, "pick");

    await t.step("записей столько, сколько перегрузок", () => {
      // Две перегрузки с разными типами возврата — ровно тот случай,
      // который вопрос и задаёт; третьей формой позвать нельзя.
      assertEquals(text.includes("объявления: 2"), true, text);
    });

    await t.step("у каждой записи своя сигнатура", () => {
      assertEquals(text.includes("pick (a: string): string"), true, text);
      assertEquals(text.includes("pick (a: number): number"), true, text);
      assertEquals(text.includes("string | number"), false, text);
    });

    await t.step("расхождение возвратов помечено", () => {
      assertEquals(
        text.includes("типы возврата: string, number — различаются"),
        true,
        text,
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("причина манифеста называет, что именно не так", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["не разобран", "{ это не json\n", "манифест не разобран"],
    // Валидный JSON-массив разбирается, но манифестом не является:
    // назвать его нечитаемым значило бы подменить один ответ соседним.
    ["не объект", "[]\n", "манифест не объект"],
  ];
  for (const [title, manifest, reason] of cases) {
    await t.step(title, async () => {
      const temp = await Deno.makeTempDir();
      try {
        const repo = await repoWith(`${temp}/r`, {
          "src/a.ts":
            "export function alpha(day: string): string {\n  return day;\n}\n",
        });
        // Сказать по такому манифесту «входа нет» значило бы выдать
        // незнание за ответ — область видимости всего репозитория
        // съехала бы молча.
        await Deno.writeTextFile(`${repo.root}/package.json`, manifest);
        const text = await name(repo, "alpha");
        assertEquals(
          text.includes(
            `экспортируется из модуля; вход проекта не определён: ${reason}`,
          ),
          true,
          text,
        );
      } finally {
        await Deno.remove(temp, { recursive: true });
      }
    });
  }
});

Deno.test("метод класса — такое же объявление", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await repoWith(`${temp}/r`, {
      "src/a.ts": [
        "export class Box {",
        "  span(x: string): number {",
        "    return x.length;",
        "  }",
        "}",
        "",
        "export function span(x: string): number {",
        "  return x.length;",
        "}",
        "",
      ].join("\n"),
    });
    // Спека требует объявлений ЛЮБОЙ формы, и метод в ней назван
    // отдельно. Метод лежит не на верхнем уровне файла, и обход по
    // одним только `statements` терял его молча.
    const text = await name(repo, "span");
    assertEquals(text.includes("объявления: 2"), true, text);
    assertEquals(
      text.includes("src/a.ts:2  span (x: string): number"),
      true,
      text,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
