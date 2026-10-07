/**
 * Объявления, которых нет в деревьях-фикстурах: перегрузки и битый
 * манифест пакета (`specs/code-name.md`).
 *
 * Оба случая про одно и то же — перечень не должен называть форму,
 * которой нет, и не должен молчать о том, чего не выяснил.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderName, runName } from "./cmd_name.ts";
import type { Repo } from "./workspace.ts";

const PROJECT =
  '{"compilerOptions":{"strict":true,"noEmit":true},' +
  '"include":["src/**/*"]}\n';

/** Репозиторий с tsconfig-проектом из заданных файлов. */
async function repoWith(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Repo> {
  await mkdir(`${root}/src`, { recursive: true });
  await writeFile(`${root}/tsconfig.json`, PROJECT);
  for (const [path, text] of Object.entries(files)) {
    await writeFile(`${root}/${path}`, text);
  }
  return {
    name: "r",
    root,
    mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
  };
}

async function name(repo: Repo, what: string): Promise<string> {
  return renderName(
    await runName(
      { name: what, in: "r", limit: 200 },
      {
        cwd: () => repo.root,
      },
      [repo],
    ),
  );
}

describe("перегрузка — отдельная запись, реализация — не запись", () => {
  let temp: string;
  let repo: Repo;
  let text: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await repoWith(`${temp}/r`, {
      "src/a.ts": [
        "export function pick(a: string): string;",
        "export function pick(a: number): number;",
        "export function pick(a: string | number): string | number {",
        "  return a;",
        "}",
        "",
      ].join("\n"),
    });
    text = await name(repo, "pick");
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("записей столько, сколько перегрузок", () => {
    // Две перегрузки с разными типами возврата — ровно тот случай,
    // который вопрос и задаёт; третьей формой позвать нельзя.
    expect(text.includes("объявления: 2"), text).toBe(true);
  });

  it("у каждой записи своя сигнатура", () => {
    expect(text.includes("pick (a: string): string"), text).toBe(true);
    expect(text.includes("pick (a: number): number"), text).toBe(true);
    expect(text.includes("string | number"), text).toBe(false);
  });

  it("расхождение возвратов помечено", () => {
    expect(
      text.includes("типы возврата: string, number — различаются"),
      text,
    ).toBe(true);
  });
});

describe("причина манифеста называет, что именно не так", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["не разобран", "{ это не json\n", "манифест не разобран"],
    // Валидный JSON-массив разбирается, но манифестом не является:
    // назвать его нечитаемым значило бы подменить один ответ соседним.
    ["не объект", "[]\n", "манифест не объект"],
  ];
  for (const [title, manifest, reason] of cases) {
    it(title, async () => {
      const temp = await mkdtemp(join(tmpdir(), "mpu-"));
      try {
        const repo = await repoWith(`${temp}/r`, {
          "src/a.ts":
            "export function alpha(day: string): string {\n  return day;\n}\n",
        });
        // Сказать по такому манифесту «входа нет» значило бы выдать
        // незнание за ответ — область видимости всего репозитория
        // съехала бы молча.
        await writeFile(`${repo.root}/package.json`, manifest);
        const text = await name(repo, "alpha");
        expect(
          text.includes(
            `экспортируется из модуля; вход проекта не определён: ${reason}`,
          ),
          text,
        ).toBe(true);
      } finally {
        await rm(temp, { recursive: true });
      }
    });
  }
});

it("метод класса — такое же объявление", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
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
    expect(text.includes("объявления: 2"), text).toBe(true);
    expect(text.includes("src/a.ts:2  span (x: string): number"), text).toBe(
      true,
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});
