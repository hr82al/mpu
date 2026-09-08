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
import type { RefsResult } from "./refs.ts";
import { assertEquals } from "@std/assert";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { buildProgram } from "./project.ts";
import { openDenoFixture } from "./testing.ts";

/**
 * Коды диагностик компилятора. Различать их текстом нельзя: сообщение
 * переформулируют или локализуют, и фильтр по подстроке молча
 * опустеет — тест начнёт зеленеть на любых диагностиках
 * (`ts/CLAUDE.md`, «Ошибки»).
 */
const NO_MODULE = 2307;
const NO_NAME = 2304;
const TS_EXTENSION = 5097;

Deno.test("refs на deno-дереве совпадает с голденом спеки", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openDenoFixture(temp);
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:3", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    assertEquals(
      renderRefs(result),
      await Deno.readTextFile(
        new URL("testdata/code/refs-symbol-deno.stdout.txt", import.meta.url),
      ),
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("свойства deno-проекта, которых нет у tsconfig-дерева", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openDenoFixture(temp);
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:3", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );

    await t.step("потребители найдены во всех трёх файлах", () => {
      assertEquals(
        answered(result).consumers.places.map((place) => place.path),
        ["mod.ts", "src/seed_test.ts", "src/window.ts"],
      );
    });

    await t.step("вход объявлен полем exports, а не index.ts", () => {
      // `index.ts` в дереве нет вовсе: вход находится только через поле
      // конфигурации, и без этого область видимости была бы «входа у
      // проекта нет».
      assertEquals(answered(result).symbol?.scope, "entry");
    });

    await t.step("внешний пакет назван поимённо, а не выброшен", () => {
      assertEquals(
        answered(result).unresolved.items.map((item) => item.specifier),
        ["./nowhere.ts", "@std/assert"],
      );
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("объявление-стрелка видно разбору по типам", async () => {
  const temp = await Deno.makeTempDir();
  try {
    // `spanDays` объявлен стрелкой: текстовый поиск по «function
    // spanDays» его не находит, и это одна из причин заводить семейство.
    const repo = await openDenoFixture(temp);
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:10", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    assertEquals(answered(result).symbol?.name, "spanDays");
    assertEquals(
      answered(result).symbol?.signature,
      "(from: string, to: string): number",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("проект собирается без диагностик, кроме неразрешённых модулей", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openDenoFixture(temp);
    const program = buildProgram(ts, {
      kind: "deno",
      path: `${repo.root}/deno.json`,
    });
    assertEquals(program !== undefined, true, "программа не построена");
    // Импорт с расширением `.ts` модуль разрешает и без разрешающей
    // опции (замер 2026-09-08) — но помечает ошибкой. На перечень
    // потребителей это не влияет, а на оракул влияет: файл, ошибочный в
    // базовом прогоне, вычитается из разности. Поэтому опция проверяется
    // здесь, у диагностик, а не у ответа.
    const complaints = program?.getSemanticDiagnostics() ?? [];
    const shown = complaints.map((diagnostic) =>
      `${diagnostic.code}: ${
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      }`
    );
    assertEquals(
      complaints.filter((diagnostic) => diagnostic.code === TS_EXTENSION),
      [],
      `расширение .ts не разрешено: ${shown}`,
    );
    // Оставшиеся диагностики — не наши: два неразрешённых модуля (они и
    // есть ответ раздела «не разрешено») и отсутствие глобального
    // `Deno`, типов которого слой не подгружает. Ни то ни другое на
    // ответ не влияет; именно поэтому оракул deno-дерева гоняет
    // `deno check`, а не проверку типов этой программой.
    assertEquals(
      complaints.filter((diagnostic) =>
        diagnostic.code !== NO_MODULE && diagnostic.code !== NO_NAME
      ),
      [],
      `неожиданные диагностики: ${shown}`,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("exclude конфигурации Deno убирает файлы из состава", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/r`;
    await Deno.mkdir(`${root}/scratch/deep`, { recursive: true });
    await Deno.mkdir(`${root}/vendor`, { recursive: true });
    await Deno.mkdir(`${root}/src`, { recursive: true });
    // Три формы записи исключения: имя, путь с `./`, путь со слэшем на
    // конце. В дереве-фикстуре канала исключённого файла нет вовсе, и
    // без этого случая ветка исключения не исполнялась бы ни разу.
    await Deno.writeTextFile(
      `${root}/deno.json`,
      '{"exclude": ["scratch", "./vendor/"]}\n',
    );
    await Deno.writeTextFile(`${root}/src/kept.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(
      `${root}/scratch/deep/skipped.ts`,
      "export const b = 2;\n",
    );
    await Deno.writeTextFile(
      `${root}/vendor/skipped.ts`,
      "export const c = 3;\n",
    );
    const program = buildProgram(ts, {
      kind: "deno",
      path: `${root}/deno.json`,
    });
    const files = (program?.getRootFileNames() ?? [])
      .map((file) => file.slice(root.length + 1)).sort();

    await t.step("исключённые не попали в состав", () => {
      assertEquals(files, ["src/kept.ts"]);
    });

    await t.step("исключение действует и на вложенные каталоги", () => {
      assertEquals(files.some((file) => file.startsWith("scratch/")), false);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("обход не заходит в каталоги с точки", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const root = `${temp}/r`;
    await Deno.mkdir(`${root}/.deno/npm`, { recursive: true });
    await Deno.mkdir(`${root}/src`, { recursive: true });
    // Кэш Deno отсечь через `exclude` конфигурации нельзя: полагаться на
    // то, что репозиторий сам его туда вписал, — совпадение, а не
    // устройство. Попади тысячи `.ts` кэша в программу, ответ стал бы
    // неверным молча (`platform/code-analyzer.md`).
    await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
    await Deno.writeTextFile(`${root}/src/kept.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(
      `${root}/.deno/npm/cached.ts`,
      "export const b = 2;\n",
    );
    const program = buildProgram(ts, {
      kind: "deno",
      path: `${root}/deno.json`,
    });
    assertEquals(
      (program?.getRootFileNames() ?? []).map((f) => f.slice(root.length + 1)),
      ["src/kept.ts"],
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

/** Ответивший раздел результата; отказ в этих проверках не ожидается. */
function answered(result: { section: { kind: string } }) {
  if (result.section.kind !== "answer") {
    throw new Error(`раздел отказал: ${JSON.stringify(result.section)}`);
  }
  return result.section as Extract<
    RefsResult["section"],
    { kind: "answer" }
  >;
}
