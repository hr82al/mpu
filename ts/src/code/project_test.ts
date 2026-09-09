/**
 * Проекты репозитория: поиск и отказы построения программы
 * (`platform/code-analyzer.md`, «Ввод/вывод», «Граничные случаи»).
 */

import ts from "typescript";
import { assertEquals, assertThrows } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { buildProgram, dirOf, findProjects } from "./project.ts";

Deno.test("проекты — только tsconfig.json и только вне артефактов", async () => {
  const temp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${temp}/src`, { recursive: true });
    await Deno.mkdir(`${temp}/pkg`, { recursive: true });
    await Deno.mkdir(`${temp}/node_modules/dep`, { recursive: true });
    await Deno.mkdir(`${temp}/dist`, { recursive: true });
    for (
      const path of [
        `${temp}/tsconfig.json`,
        `${temp}/pkg/tsconfig.json`,
        // Ни один из трёх проектом не считается: имя не то либо каталог
        // артефактов и зависимостей.
        `${temp}/tsconfig.base.json`,
        `${temp}/node_modules/dep/tsconfig.json`,
        `${temp}/dist/tsconfig.json`,
      ]
    ) {
      await Deno.writeTextFile(path, "{}\n");
    }
    assertEquals(findProjects(temp), [
      { kind: "tsconfig", path: `${temp}/pkg/tsconfig.json` },
      { kind: "tsconfig", path: `${temp}/tsconfig.json` },
    ]);
    // Каталога нет — пусто, а не исключение: репозиторий мог исчезнуть
    // между снятием списка и обходом.
    assertEquals(findProjects(`${temp}/nowhere`), []);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("исключения кода снимаются, исключения артефактов остаются", async () => {
  const temp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${temp}/src`, { recursive: true });
    await Deno.mkdir(`${temp}/out`, { recursive: true });
    await Deno.mkdir(`${temp}/node_modules/dep`, { recursive: true });
    await Deno.writeTextFile(
      `${temp}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: { noEmit: true, outDir: "out" },
        include: ["**/*"],
        exclude: ["**/*.spec.ts"],
      }),
    );
    await Deno.writeTextFile(`${temp}/src/a.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(`${temp}/src/a.spec.ts`, "export const b = 2;\n");
    await Deno.writeTextFile(`${temp}/out/built.ts`, "export const c = 3;\n");
    await Deno.writeTextFile(
      `${temp}/node_modules/dep/index.ts`,
      "export const d = 4;\n",
    );
    const built = buildProgram(ts, {
      kind: "tsconfig",
      path: `${temp}/tsconfig.json`,
    }, temp);
    if (built.kind !== "program") {
      throw new Error(`программа не построена: ${built.kind}`);
    }
    assertEquals(
      built.program.getRootFileNames().map((name) =>
        name.slice(temp.length + 1)
      )
        .sort(),
      ["src/a.spec.ts", "src/a.ts"],
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("конфигурация без входных файлов проектом не считается", async () => {
  const temp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${temp}/tsconfig.json`,
      '{"include":["nothing/**/*"]}\n',
    );
    // Отказом это быть не может: solution-style конфиг рядом с рабочим
    // проектом положил бы весь ответ по репозиторию.
    assertEquals(
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ).kind,
      "empty",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("непостроенная программа — отказ с причиной", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    await t.step("конфигурации нет", () => {
      assertThrows(
        () =>
          buildProgram(
            ts,
            { kind: "tsconfig", path: `${temp}/tsconfig.json` },
            temp,
          ),
        DomainError,
        "не читается",
      );
    });
    await t.step("конфигурация не разбирается", async () => {
      // Файл проекту нужен: конфигурация без входных файлов проектом не
      // считается вовсе и до разговора об ошибках не доходит.
      await Deno.mkdir(`${temp}/src`, { recursive: true });
      await Deno.writeTextFile(`${temp}/src/a.ts`, "export const a = 1;\n");
      await Deno.writeTextFile(
        `${temp}/tsconfig.json`,
        '{"compilerOptions":{"target":"НЕТ ТАКОЙ"},"include":["src/**/*"]}\n',
      );
      assertThrows(
        () =>
          buildProgram(
            ts,
            { kind: "tsconfig", path: `${temp}/tsconfig.json` },
            temp,
          ),
        DomainError,
        "не разбирается",
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("каталог пути", () => {
  assertEquals(dirOf("/w/repo/tsconfig.json"), "/w/repo");
});

Deno.test("окно отбирает по составу, а не по каталогу конфигурации", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // `include` тянет в проект файлы вне его каталога, и отбор по месту
    // конфигурации потерял бы их: программа не построилась бы там, где
    // весь ответ и лежит.
    await Deno.mkdir(`${temp}/pkg`, { recursive: true });
    await Deno.mkdir(`${temp}/shared`, { recursive: true });
    await Deno.writeTextFile(
      `${temp}/pkg/tsconfig.json`,
      '{"compilerOptions":{"strict":true,"noEmit":true},' +
        '"include":["../shared/**/*"]}\n',
    );
    await Deno.writeTextFile(
      `${temp}/shared/a.ts`,
      "export const a = 1;\n",
    );
    const built = buildProgram(
      ts,
      { kind: "tsconfig", path: `${temp}/pkg/tsconfig.json` },
      temp,
      `${temp}/shared`,
    );
    assertEquals(built.kind, "program", "состав окна не увиден");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
