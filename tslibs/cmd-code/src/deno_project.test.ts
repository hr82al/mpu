/**
 * Второй вид проекта — конфигурация Deno (`platform/code-analyzer.md`,
 * «Проект»).
 *
 * Вид обязателен, а не удобство: без него репозиторий на Deno не имеет
 * проектов вовсе, и команда отказывает по нему на любой вопрос о
 * символе. Здесь проверяется, что ответ по такому дереву совпадает с
 * голденом, снятым оракулом, и что три свойства, которых нет у
 * tsconfig-дерева, работают: импорт с расширением `.ts`, вход, объявленный
 * полем `exports`, и внешний пакет, уходящий в «не разрешено» поимённо.
 */

import ts from "typescript";
import type TS from "typescript";
import type { RefsResult } from "./refs.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { buildProgram, type Built } from "./project.ts";
import { openDenoFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/**
 * Коды диагностик компилятора. Различать их текстом нельзя: сообщение
 * переформулируют или локализуют, и фильтр по подстроке молча
 * опустеет — тест начнёт зеленеть на любых диагностиках
 * (`ts/CLAUDE.md`, «Ошибки»).
 */
const NO_MODULE = 2307;
const NO_NAME = 2304;
const TS_EXTENSION = 5097;

it("refs на deno-дереве совпадает с голденом спеки", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openDenoFixture(temp);
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:3", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(renderRefs(result)).toStrictEqual(
      await readFile(
        new URL("testdata/code/refs-symbol-deno.stdout.txt", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("свойства deno-проекта, которых нет у tsconfig-дерева", () => {
  let temp: string;
  let repo: Repo;
  let result: {
    section:
      | {
          kind: "answer";
          mark: {
            repo: string;
            git: { branch: string; commit: string; dirty: boolean } | null;
          };
          guarantee: "types" | "text";
          target: {
            kind: "symbol" | "module";
            path: string;
            line: number | null;
          };
          symbol: {
            name: string;
            signature: string;
            scope:
              | "entry"
              | "module-only"
              | "no-entry"
              | "entry-unparsed"
              | "entry-not-object"
              | "private";
          } | null;
          consumers: {
            total: number;
            places: { path: string; line: number }[];
          };
          unresolved: {
            total: number;
            items: {
              path: string;
              line: number;
              specifier: string;
              reason: string;
            }[];
          };
        }
      | {
          kind: "refused";
          mark: {
            repo: string;
            git: { branch: string; commit: string; dirty: boolean } | null;
          };
          refusal: string;
        };
  };
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openDenoFixture(temp);
    result = await runRefs(
      { address: "deno-fixture:src/days.ts:3", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("потребители найдены во всех трёх файлах", () => {
    expect(
      answered(result).consumers.places.map((place) => place.path),
    ).toStrictEqual(["mod.ts", "src/seed_test.ts", "src/window.ts"]);
  });

  it("вход объявлен полем exports, а не index.ts", () => {
    // `index.ts` в дереве нет вовсе: вход находится только через поле
    // конфигурации, и без этого область видимости была бы «входа у
    // проекта нет».
    expect(answered(result).symbol?.scope).toBe("entry");
  });

  it("внешний пакет назван поимённо, а не выброшен", () => {
    expect(
      answered(result).unresolved.items.map((item) => item.specifier),
    ).toStrictEqual(["./nowhere.ts", "@std/assert"]);
  });
});

it("объявление-стрелка видно разбору по типам", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // `spanDays` объявлен стрелкой: текстовый поиск по «function
    // spanDays» его не находит, и это одна из причин заводить семейство.
    const repo = await openDenoFixture(temp);
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:10", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(answered(result).symbol?.name).toBe("spanDays");
    expect(answered(result).symbol?.signature).toBe(
      "(from: string, to: string): number",
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("проект собирается без диагностик, кроме неразрешённых модулей", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openDenoFixture(temp);
    const program = program_(
      buildProgram(
        ts,
        {
          kind: "deno",
          path: `${repo.root}/deno.json`,
        },
        repo.root,
      ),
    );
    // Импорт с расширением `.ts` модуль разрешает и без разрешающей
    // опции (замер 2026-09-08) — но помечает ошибкой. На перечень
    // потребителей это не влияет, а на оракул влияет: файл, ошибочный в
    // базовом прогоне, вычитается из разности. Поэтому опция проверяется
    // здесь, у диагностик, а не у ответа.
    const complaints = program.getSemanticDiagnostics();
    const shown = complaints.map(
      (diagnostic) =>
        `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          " ",
        )}`,
    );
    expect(
      complaints.filter((diagnostic) => diagnostic.code === TS_EXTENSION),
      `расширение .ts не разрешено: ${shown}`,
    ).toStrictEqual([]);
    // Оставшиеся диагностики — не наши: два неразрешённых модуля (они и
    // есть ответ раздела «не разрешено») и отсутствие глобального
    // `Deno`, типов которого слой не подгружает. Ни то ни другое на
    // ответ не влияет; именно поэтому оракул deno-дерева гоняет
    // `deno check`, а не проверку типов этой программой.
    expect(
      complaints.filter(
        (diagnostic) =>
          diagnostic.code !== NO_MODULE && diagnostic.code !== NO_NAME,
      ),
      `неожиданные диагностики: ${shown}`,
    ).toStrictEqual([]);
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("exclude конфигурации Deno убирает файлы из состава", () => {
  let temp: string;
  let root: string;
  let program: TS.Program;
  let files: string[];
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    root = `${temp}/r`;
    await mkdir(`${root}/scratch/deep`, { recursive: true });
    await mkdir(`${root}/vendor`, { recursive: true });
    await mkdir(`${root}/src`, { recursive: true });
    // Три формы записи исключения: имя, путь с `./`, путь со слэшем на
    // конце. В дереве-фикстуре канала исключённого файла нет вовсе, и
    // без этого случая ветка исключения не исполнялась бы ни разу.
    await writeFile(
      `${root}/deno.json`,
      '{"exclude": ["scratch", "./vendor/"]}\n',
    );
    await writeFile(`${root}/src/kept.ts`, "export const a = 1;\n");
    await writeFile(`${root}/scratch/deep/skipped.ts`, "export const b = 2;\n");
    await writeFile(`${root}/vendor/skipped.ts`, "export const c = 3;\n");
    program = program_(
      buildProgram(
        ts,
        {
          kind: "deno",
          path: `${root}/deno.json`,
        },
        root,
      ),
    );
    files = program
      .getRootFileNames()
      .map((file) => file.slice(root.length + 1))
      .sort();
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("исключённые не попали в состав", () => {
    expect(files).toStrictEqual(["src/kept.ts"]);
  });

  it("исключение действует и на вложенные каталоги", () => {
    expect(files.some((file) => file.startsWith("scratch/"))).toBe(false);
  });
});

it("обход не заходит в каталоги с точки", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const root = `${temp}/r`;
    await mkdir(`${root}/.deno/npm`, { recursive: true });
    await mkdir(`${root}/src`, { recursive: true });
    // Кэш Deno отсечь через `exclude` конфигурации нельзя: полагаться на
    // то, что репозиторий сам его туда вписал, — совпадение, а не
    // устройство. Попади тысячи `.ts` кэша в программу, ответ стал бы
    // неверным молча (`platform/code-analyzer.md`).
    await writeFile(`${root}/deno.json`, "{}\n");
    await writeFile(`${root}/src/kept.ts`, "export const a = 1;\n");
    await writeFile(`${root}/.deno/npm/cached.ts`, "export const b = 2;\n");
    const program = program_(
      buildProgram(
        ts,
        {
          kind: "deno",
          path: `${root}/deno.json`,
        },
        root,
      ),
    );
    expect(
      program.getRootFileNames().map((f) => f.slice(root.length + 1)),
    ).toStrictEqual(["src/kept.ts"]);
  } finally {
    await rm(temp, { recursive: true });
  }
});

/** Построенная программа; иного исхода эти проверки не ожидают. */
function program_(built: Built): TS.Program {
  if (built.kind !== "program") {
    throw new Error(`программа не построена: ${built.kind}`);
  }
  return built.program;
}

/** Ответивший раздел результата; отказ в этих проверках не ожидается. */
function answered(result: { section: { kind: string } }) {
  if (result.section.kind !== "answer") {
    throw new Error(`раздел отказал: ${JSON.stringify(result.section)}`);
  }
  return result.section as Extract<RefsResult["section"], { kind: "answer" }>;
}
