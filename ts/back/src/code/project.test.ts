/**
 * Проекты репозитория: поиск и отказы построения программы
 * (`platform/code-analyzer.md`, «Ввод/вывод», «Граничные случаи»).
 */

import ts from "typescript";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../command/mod.ts";
import { buildProgram, dirOf, findProjects } from "./project.ts";

it("проекты — только tsconfig.json и только вне артефактов", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${temp}/src`, { recursive: true });
    await mkdir(`${temp}/pkg`, { recursive: true });
    await mkdir(`${temp}/node_modules/dep`, { recursive: true });
    await mkdir(`${temp}/dist`, { recursive: true });
    for (const path of [
      `${temp}/tsconfig.json`,
      `${temp}/pkg/tsconfig.json`,
      // Ни один из трёх проектом не считается: имя не то либо каталог
      // артефактов и зависимостей.
      `${temp}/tsconfig.base.json`,
      `${temp}/node_modules/dep/tsconfig.json`,
      `${temp}/dist/tsconfig.json`,
    ]) {
      await writeFile(path, "{}\n");
    }
    expect(findProjects(temp)).toStrictEqual([
      { kind: "tsconfig", path: `${temp}/pkg/tsconfig.json` },
      { kind: "tsconfig", path: `${temp}/tsconfig.json` },
    ]);
    // Каталога нет — пусто, а не исключение: репозиторий мог исчезнуть
    // между снятием списка и обходом.
    expect(findProjects(`${temp}/nowhere`)).toStrictEqual([]);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("исключения кода снимаются, исключения артефактов остаются", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${temp}/src`, { recursive: true });
    await mkdir(`${temp}/out`, { recursive: true });
    await mkdir(`${temp}/node_modules/dep`, { recursive: true });
    await writeFile(
      `${temp}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: { noEmit: true, outDir: "out" },
        include: ["**/*"],
        exclude: ["**/*.spec.ts"],
      }),
    );
    await writeFile(`${temp}/src/a.ts`, "export const a = 1;\n");
    await writeFile(`${temp}/src/a.spec.ts`, "export const b = 2;\n");
    await writeFile(`${temp}/out/built.ts`, "export const c = 3;\n");
    await writeFile(
      `${temp}/node_modules/dep/index.ts`,
      "export const d = 4;\n",
    );
    const built = buildProgram(
      ts,
      {
        kind: "tsconfig",
        path: `${temp}/tsconfig.json`,
      },
      temp,
    );
    if (built.kind !== "program") {
      throw new Error(`программа не построена: ${built.kind}`);
    }
    expect(
      built.program
        .getRootFileNames()
        .map((name) => name.slice(temp.length + 1))
        .sort(),
    ).toStrictEqual(["src/a.spec.ts", "src/a.ts"]);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("конфигурация без входных файлов проектом не считается", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await writeFile(`${temp}/tsconfig.json`, '{"include":["nothing/**/*"]}\n');
    // Отказом это быть не может: solution-style конфиг рядом с рабочим
    // проектом положил бы весь ответ по репозиторию.
    expect(
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ).kind,
    ).toBe("empty");
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("непостроенная программа — отказ с причиной", () => {
  let temp: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  it("конфигурации нет", () => {
    expect(() =>
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ),
    ).toThrow(DomainError);
    expect(() =>
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ),
    ).toThrow("не читается");
  });
  it("конфигурация не разбирается", async () => {
    // Файл проекту нужен: конфигурация без входных файлов проектом не
    // считается вовсе и до разговора об ошибках не доходит.
    await mkdir(`${temp}/src`, { recursive: true });
    await writeFile(`${temp}/src/a.ts`, "export const a = 1;\n");
    await writeFile(
      `${temp}/tsconfig.json`,
      '{"compilerOptions":{"target":"НЕТ ТАКОЙ"},"include":["src/**/*"]}\n',
    );
    expect(() =>
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ),
    ).toThrow(DomainError);
    expect(() =>
      buildProgram(
        ts,
        { kind: "tsconfig", path: `${temp}/tsconfig.json` },
        temp,
      ),
    ).toThrow("не разбирается");
  });
});

it("каталог пути", () => {
  expect(dirOf("/w/repo/tsconfig.json")).toBe("/w/repo");
});

it("окно отбирает по составу, а не по каталогу конфигурации", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // `include` тянет в проект файлы вне его каталога, и отбор по месту
    // конфигурации потерял бы их: программа не построилась бы там, где
    // весь ответ и лежит.
    await mkdir(`${temp}/pkg`, { recursive: true });
    await mkdir(`${temp}/shared`, { recursive: true });
    await writeFile(
      `${temp}/pkg/tsconfig.json`,
      '{"compilerOptions":{"strict":true,"noEmit":true},' +
        '"include":["../shared/**/*"]}\n',
    );
    await writeFile(`${temp}/shared/a.ts`, "export const a = 1;\n");
    const built = buildProgram(
      ts,
      { kind: "tsconfig", path: `${temp}/pkg/tsconfig.json` },
      temp,
      `${temp}/shared`,
    );
    expect(built.kind, "состав окна не увиден").toBe("program");
  } finally {
    await rm(temp, { recursive: true });
  }
});
